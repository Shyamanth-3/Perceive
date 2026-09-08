import logging
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Load environment variables from .env file
load_dotenv()

from schemas import ClientPayload, ServerResponse, TelemetryPayload, Action
from session_manager import SessionManager
from audit_logger import AuditLogger
from llm_client import LLMClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="ISRO Privacy Agent Backend")

# Allow CORS so the browser extension can talk to the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Restrict to specific domains in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize core components
session_manager = SessionManager()
audit_logger = AuditLogger()
llm_client = LLMClient()

@app.post("/analyze", response_model=ServerResponse)
async def analyze(payload: ClientPayload):
    try:
        session = session_manager.get_or_create_session(payload.session_id)
        
        # 1. Summarize payload for audit (never log raw PII)
        payload_summary = {
            "url": payload.dom_summary.url,
            "elements_count": len(payload.dom_summary.elements),
            "sensitive_elements": sum(1 for el in payload.dom_summary.elements if el.is_sensitive)
        }
        
        # 2. Get LLM action (with automatic fallback if Groq fails)
        action_dict = llm_client.get_action(
            task_instruction=payload.task_instruction,
            dom_summary=payload.dom_summary.dict(),
            session_history=session["history"]
        )
        
        # 3. Validate action against Pydantic schema
        action = Action(**action_dict)
        
        response = ServerResponse(
            session_id=payload.session_id,
            step_number=payload.step_number,
            action=action,
            confidence=0.85 # Placeholder, can be extracted from LLM metadata if available
        )
        
        # 4. Update state and write to audit log
        session_manager.update_session(payload.session_id, payload.step_number, action.dict())
        audit_logger.log_step(
            session_id=payload.session_id,
            step_number=payload.step_number,
            payload_summary=payload_summary,
            action=action.dict(),
            confidence=response.confidence
        )
        
        return response

    except Exception as e:
        logger.error(f"Error processing /analyze: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/telemetry")
async def receive_telemetry(telemetry: TelemetryPayload):
    """Dev 5's latency instrumentation endpoint."""
    logger.info(f"[Telemetry] Session {telemetry.session_id} | Step {telemetry.step_number} | Total: {telemetry.total_latency_ms}ms")
    # In a full implementation, you could append this to a telemetry.jsonl file for the dashboard
    return {"status": "received", "message": "Telemetry logged."}

@app.get("/health")
async def health_check():
    return {"status": "healthy", "fallback_loaded": llm_client.fallback_response is not None}