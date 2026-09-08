import os
import json
from groq import Groq
from typing import Dict, Any
import logging

logger = logging.getLogger(__name__)

class LLMClient:
    def __init__(self, fallback_response_path: str = "fallback_response.json"):
        # Ensure you set GROQ_API_KEY in your environment variables
        self.client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
        self.fallback_response_path = fallback_response_path
        self._load_fallback()

    def _load_fallback(self):
        if os.path.exists(self.fallback_response_path):
            with open(self.fallback_response_path, "r") as f:
                self.fallback_response = json.load(f)
            logger.info("Emergency fallback response loaded successfully.")
        else:
            self.fallback_response = None
            logger.warning("No fallback_response.json found. Live demo is at risk if Groq fails.")

    def get_action(self, task_instruction: str, dom_summary: Dict[str, Any], session_history: list) -> Dict[str, Any]:
        history_str = json.dumps(session_history[-5:])
        dom_str = json.dumps(dom_summary)
        
        prompt = f"""
You are an AI assistant helping a user complete a task on a webpage. 
The user's screen has been sanitized for privacy. Sensitive values are replaced with semantic tokens (e.g., [CARD_NUMBER], [AMOUNT]).
Task: {task_instruction}
Current DOM Summary: {dom_str}
Recent History: {history_str}

Determine the next action to take. Respond ONLY with a valid JSON object matching this schema:
{{
  "type": "click | type | scroll | wait | ask_user_confirmation | task_complete | task_failed",
  "target_element_id": "string or null",
  "value": "string or null",
  "risk_tier": "safe | risky",
  "reasoning_short": "string"
}}
"""
        try:
            response = self.client.chat.completions.create(
                model="llama-3.3-70b-versatile", 
                messages=[
                    {"role": "system", "content": "You are a helpful UI automation assistant. Output strictly valid JSON."},
                    {"role": "user", "content": prompt}
                ],
                response_format={"type": "json_object"},
                temperature=0.1
            )
            content = response.choices[0].message.content
            return json.loads(content)
        except Exception as e:
            logger.error(f"Groq API call failed: {e}. Triggering emergency fallback.")
            if self.fallback_response:
                return self.fallback_response
            raise e