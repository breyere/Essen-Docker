#!/usr/bin/env python3
import http.server
import socketserver
import json
import os
import sys
import urllib.request
import urllib.parse
from pathlib import Path
import ssl


GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '').strip()
MODEL = os.environ.get('GEMINI_MODEL', 'gemini-1.5-flash')


def build_schema(start_iso: str) -> str:
    return (
        "Du bist eine Koch-KI für eine Familie. Erstelle für die Woche ab "
        + start_iso
        + " einen abwechslungsreichen Plan (7 Tage), pro Tag GENAU EIN Essen: das Mittagessen. "
          "Das Mittagessen soll zusammenpassen (Hauptgericht + passende Beilage/Salat). Variiere die Küchenrichtungen. "
          "Vermeide Wiederholungen aus den letzten Wochen.\n"
          "Werte Vorlieben aus: Bevorzuge Gerichte mit vielen Likes und meide Dislikes. Wenn nötig, wähle neutrale Optionen. "
          "Analysiere KOMMENTARE der Familie (Felder: week, date, mealName, items[], text, by, when): "
          "Leite pro Gericht (anhand der items[].name) eine klare Tendenz ab (positiv/neutral/negativ: z.B. schmeckt gut/nicht gut/zu oft). "
          "Bevorzuge Gerichte mit positiver Tendenz, meide negative – und beachte Hinweise zur Häufigkeit (\"zu oft\"). "
          "Nutze NUR aus folgender Gerichte-Liste (Name, Typ, Tags). Falls nicht genug passt, ersetze fehlende Positionen durch sinnvolle Platzhalter, die zur Richtung passen.\n"
          "Wenn eine benutzerdefinierte Anweisung (Prompt) vorhanden ist, halte dich daran.\n\n"
          "Antworte AUSSCHLIESSLICH mit gültigem JSON ohne extra Text. Schema:\n"
          "{\n"
          "  \"weekStart\": \"YYYY-MM-DD\",\n"
          "  \"days\": [\n"
          "    { \"date\": \"YYYY-MM-DD\", \"theme\": \"string\", \"meals\": [\n"
          "      { \"name\": \"Mittagessen\", \"items\": [ {\"name\":\"...\",\"type\":\"Hauptgericht|Beilage|Salat\"}, ... ] }\n"
          "    ]}\"n"
          "  ],\n"
          "  \"comments\": {},\n"
          "  \"source\": \"ai\",\n"
          "  \"aiMessage\": \"Kurze, freundliche Begründung auf Deutsch mit Hinweis auf berücksichtigte Kommentare/Vorlieben\"\n"
          "}\n"
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        self._root = Path(directory or os.getcwd()).resolve()
        super().__init__(*args, directory=str(self._root), **kwargs)

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args))
        except Exception:
            pass

    def do_POST(self):
        if self.path not in ("/api/generate", "/api/search"):
            self.send_error(404, "Not Found")
            return
        if not GEMINI_API_KEY:
            self.send_json({"error": "server_misconfigured", "message": "GEMINI_API_KEY not set"}, 500)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode('utf-8') or '{}')
        except Exception as e:
            self.send_json({"error": "bad_request", "message": str(e)}, 400)
            return

        # shared input
        start_iso = str(data.get('startIso') or '')
        foods = data.get('foods') or []
        profiles = data.get('profiles') or []
        prefs = data.get('prefs') or {}
        recently = data.get('recently') or []
        comments = data.get('comments') or []
        history = data.get('history') or []
        custom_prompt = data.get('customPrompt') or ''
        query = str(data.get('query') or '')

        if self.path == "/api/generate":
            text_prompt = build_schema(start_iso) + "\n" + json.dumps({
                "foods": foods,
                "profiles": profiles,
                "prefs": prefs,
                "recently": recently,
                "comments": comments,
                "history": history,
                "customPrompt": custom_prompt,
            }, ensure_ascii=False)
        else:
            # KI-Suche Schema
            search_schema = (
                "Du bist eine Suche über Essensdaten (foods, plans/history, comments, prefs). "
                "Beantworte die Nutzerfrage präzise und gib strukturierte Ergebnisse zurück.\n"
                "Antworte ausschließlich als JSON im Format:\n"
                "{\n"
                "  \"answer\": \"kurzer Text\",\n"
                "  \"foodMatches\": [{\"id\":\"\",\"name\":\"\",\"type\":\"\",\"tags\":[...],\"score\":0..1,\"why\":\"\"}],\n"
                "  \"planMatches\": [{\"weekStart\":\"YYYY-MM-DD\",\"date\":\"YYYY-MM-DD\",\"mealName\":\"\",\"items\":[{\"name\":\"\",\"type\":\"\"}],\"why\":\"\"}],\n"
                "  \"commentInsights\": [{\"date\":\"YYYY-MM-DD\",\"mealName\":\"\",\"text\":\"\",\"by\":\"\",\"sentiment\":\"positive|neutral|negative\",\"why\":\"\"}]\n"
                "}\n"
                "Wenn keine Treffer, gib leere Arrays zurück.\n"
            )
            text_prompt = search_schema + "\nNutzerfrage: " + query + "\n" + json.dumps({
                "foods": foods,
                "profiles": profiles,
                "prefs": prefs,
                "history": history,
                "comments": comments,
            }, ensure_ascii=False)

        payload = {
            "contents": [
                {"role": "user", "parts": [{"text": text_prompt}]} 
            ],
            "generationConfig": {
                "temperature": 0.4,
                "topP": 0.9,
                "maxOutputTokens": 1536,
                "responseMimeType": "application/json",
            },
        }

        try:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key="
                + urllib.parse.quote(GEMINI_API_KEY)
            )
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                res_json = json.loads(resp.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode('utf-8')
            except Exception:
                body = ''
            self.send_json({"error": "upstream_http", "status": e.code, "body": body}, 502)
            return
        except Exception as e:
            self.send_json({"error": "upstream_error", "message": str(e)}, 502)
            return

        # Extract model text and parse JSON
        text = (
            (((res_json.get('candidates') or [{}])[0].get('content') or {}).get('parts') or [{}])[0].get('text')
            or ''
        )
        json_str = text.strip()
        if json_str.startswith('```'):
            json_str = json_str.split('\n', 1)[-1]
        if json_str.endswith('```'):
            json_str = json_str[:-3].strip()
        try:
            parsed = json.loads(json_str)
        except Exception:
            self.send_json({"error": "parse_error", "raw": text[:2000]}, 502)
            return

        if self.path == "/api/generate":
            if not parsed or 'days' not in parsed:
                self.send_json({"error": "bad_plan"}, 502)
                return
            self.send_json(parsed, 200)
        else:
            # search
            if not isinstance(parsed, dict):
                parsed = {"answer": "", "foodMatches": [], "planMatches": [], "commentInsights": []}
            parsed.setdefault("answer", "")
            parsed.setdefault("foodMatches", [])
            parsed.setdefault("planMatches", [])
            parsed.setdefault("commentInsights", [])
            self.send_json(parsed, 200)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def run_server():
    """
    Diese Funktion startet den Webserver, damit die App im Netzwerk erreichbar ist.
    """
    host = "0.0.0.0"
    port = 5173
    
    # Stellt sicher, dass wir im richtigen Verzeichnis sind
    web_dir = Path(__file__).parent.resolve()
    
    handler = lambda *args, **kwargs: Handler(*args, directory=str(web_dir), **kwargs)
    
    with socketserver.ThreadingTCPServer((host, port), handler) as httpd:
        print(f"Server startet auf http://{host}:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer wird heruntergefahren.")
            pass

if __name__ == '__main__':
    run_server()