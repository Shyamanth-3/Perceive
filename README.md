# Perceive: Privacy-Preserving Web Automation Agent

Perceive is a privacy-first web automation agent backend. It processes webpage interactions by replacing sensitive user credentials and personally identifiable information (PII) with semantic tokens before querying large language models.

---

## Key Features

- **DOM Privacy Sanitization**: Evaluates DOM nodes, sensitivity tiers (Tier 1-3), and sensitive types (passwords, card numbers, emails, names, amounts).
- **Semantic Tokenization**: Replaces sensitive values with tokens (e.g., `[CARD_NUMBER]`, `[AMOUNT]`) before inference.
- **LLM-Driven Action Generation**: Uses Groq-hosted `llama-3.3-70b-versatile` to decide the next action (`click`, `type`, `scroll`, `wait`, `ask_user_confirmation`, `task_complete`, `task_failed`).
- **Resilient Offline Fallback**: Features an automated fallback mechanism (`fallback_response.json`) if external LLM APIs encounter network or rate limit issues.
- **Strict Audit Logging**: Records sanitized request metadata and agent actions to `audit_log.jsonl` without exposing sensitive user inputs.
- **Telemetry & Latency Tracking**: `/telemetry` endpoint to capture stage-by-stage pipeline latencies.

---

## Project Structure

```
Perceive/
├── backend/
│   ├── audit_logger.py          # Structured JSONL logger for sanitized session steps
│   ├── fallback_response.json   # Deterministic fallback response for live demos
│   ├── llm_client.py            # Groq API client with fallback handler
│   ├── main.py                  # FastAPI application and endpoint definitions
│   ├── requirements.txt         # Python dependencies
│   ├── schemas.py               # Pydantic models for request/response validation
│   ├── session_manager.py       # In-memory bounded session state management
│   ├── .env                     # Environment variables (GROQ_API_KEY)
│   └── .gitignore               # Backend gitignore
├── .vscode/
│   ├── launch.json              # VS Code debug configuration for FastAPI
│   └── settings.json            # VS Code python environment settings
├── .gitignore                   # Repository gitignore
├── run_server.bat               # Quick-start script for Windows
└── README.md                    # Project documentation
```

---

## Getting Started

### 1. Prerequisites
- Python 3.10+ (tested on Python 3.14)
- A Groq Cloud API key

### 2. Environment Setup
Create and activate a virtual environment:
```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
```

Install the dependencies:
```powershell
pip install -r requirements.txt
```

### 3. Configure Environment Variables
Edit `backend/.env` and insert your Groq API key:
```env
GROQ_API_KEY=gsk_your_groq_api_key_here
```

### 4. Run the Backend Server
Using the quick-start script:
```powershell
.\run_server.bat
```
Or directly with uvicorn:
```powershell
cd backend
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The API will be available at `http://127.0.0.1:8000`. Interactive documentation is available at `http://127.0.0.1:8000/docs`.

---

## API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Health status and fallback readiness check |
| `POST` | `/analyze` | Receives DOM summary and returns the next automated action |
| `POST` | `/telemetry` | Records client and pipeline latency stages |
