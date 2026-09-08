from typing import Dict, Any

class SessionManager:
    def __init__(self):
        self.sessions: Dict[str, Dict[str, Any]] = {}

    def get_or_create_session(self, session_id: str) -> Dict[str, Any]:
        if session_id not in self.sessions:
            self.sessions[session_id] = {"history": [], "current_step": 0}
        return self.sessions[session_id]

    def update_session(self, session_id: str, step_number: int, action: dict):
        session = self.get_or_create_session(session_id)
        session["current_step"] = step_number
        # Keep history bounded to prevent context window overflow
        session["history"].append({"step": step_number, "action": action})
        if len(session["history"]) > 10:
            session["history"] = session["history"][-10:]