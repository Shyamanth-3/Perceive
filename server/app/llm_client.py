import os
import json
from typing import Any, Dict
from groq import AsyncGroq
from .models import ClientPayload, ActionInstruction
from .session import get_or_create_session

def get_llm_client():
    provider = os.getenv("LLM_PROVIDER", "groq").lower()
    if provider == "offline":
        base_url = os.getenv("OFFLINE_API_BASE", "http://localhost:11434/v1")
        # Reuse Groq client pointing to local OpenAI-compatible endpoint
        return AsyncGroq(
            api_key="offline-local",
            base_url=base_url,
        )
    else:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY environment variable not set")
        return AsyncGroq(api_key=api_key)

async def generate_action(payload: ClientPayload) -> ActionInstruction:
    session = get_or_create_session(payload.session_id)
    history_context = session.get_context_string()
    
    model_name = os.getenv("MODEL_NAME", "llama-3.3-70b-versatile")
    client = get_llm_client()
    
    system_prompt = """You are a highly capable browser automation agent.
Your task is to analyze the user's instruction and the current state of the webpage (DOM Summary) to determine the next action.
You MUST output your response as valid JSON matching the ActionInstruction schema.
IMPORTANT: You MUST NEVER output real sensitive values (passwords, card numbers, etc). If interacting with a sensitive field, use the provided `semantic_token`.
"""
    
    user_prompt = f"""
Task Instruction: {payload.task_instruction}
Step Number: {payload.step_number}

History:
{history_context}

DOM Summary:
{payload.dom_summary.model_dump_json(indent=2)}

Detection Confidence Notes:
{json.dumps([n.model_dump() for n in payload.detection_confidence_notes], indent=2)}

Determine the next action to take. Output strictly as JSON.
"""

    response = await client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.0,
        response_format={"type": "json_object"}
    )
    
    raw_response = response.choices[0].message.content
    if not raw_response:
        raise ValueError("Empty response from LLM")
        
    action_dict = json.loads(raw_response)
    # This will be validated by Pydantic in the caller
    action = ActionInstruction(**action_dict)
    return action
