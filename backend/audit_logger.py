import json
import os
from datetime import datetime
from typing import Any, Dict

class AuditLogger:
    def __init__(self, log_file: str = "audit_log.jsonl"):
        self.log_file = log_file
        os.makedirs(os.path.dirname(self.log_file) if os.path.dirname(self.log_file) else '.', exist_ok=True)

    def log_step(self, session_id: str, step_number: int, payload_summary: Dict[str, Any], action: Dict[str, Any], confidence: float):
        log_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "session_id": session_id,
            "step_number": step_number,
            "payload_summary": payload_summary,
            "action": action,
            "confidence": confidence
        }
        with open(self.log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")