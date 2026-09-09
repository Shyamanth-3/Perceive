import json
import logging
import os
from datetime import datetime

# Basic setup for JSONL logging
LOG_FILE = os.getenv("AUDIT_LOG_FILE", "audit.jsonl")

def log_audit_event(session_id: str, step_number: int, instruction: str, action: dict, confidence: float, payload_notes: list):
    """
    Records an audit event containing context, decision, and confidence.
    """
    event = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "session_id": session_id,
        "step_number": step_number,
        "instruction": instruction,
        "action": action,
        "confidence": confidence,
        "payload_notes": payload_notes
    }
    
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")
