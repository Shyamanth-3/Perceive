import os
import json
import logging
from typing import Any, Dict
from groq import AsyncGroq
from .models import ClientPayload, ActionInstruction
from .session import get_or_create_session

logger = logging.getLogger("perceive.llm_client")

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

def _generate_deterministic_test_action(payload: ClientPayload) -> ActionInstruction:
    """
    TEST-ONLY scripted action generator — the ONLY thing this replaces is the
    nondeterministic external Groq call. Everything downstream in main.py's
    /analyze (hallucination guard against the REAL dom_summary, the
    server-authoritative risk_tier override, session continuity, the retry
    loop, audit logging) still runs for real against whatever this returns.
    Activated ONLY when LLM_PROVIDER=deterministic_test is explicitly set —
    never the default, never reachable on the demo path by accident (see
    get_llm_client(), which is the single gate for this).
    """
    elements = payload.dom_summary.elements
    session = get_or_create_session(payload.session_id)
    already_targeted = {
        step["action"].get("target_element_id")
        for step in session.history
        if step.get("action")
    }

    def is_visible(el) -> bool:
        # dom_summary carries a bounding_box but no explicit `visible` flag —
        # a display:none element still gets a bounding_box, just zeroed. A
        # real LLM has the same limited signal; this mock uses it the same
        # way a competent one should, rather than assuming presence in the
        # DOM means the element is currently usable.
        bb = el.bounding_box
        return bool(bb) and bb.w > 0 and bb.h > 0

    def find(pred):
        return next((el for el in elements if pred(el) and is_visible(el)), None)

    on_checkout_page = find(lambda el: el.label_text and "card number" in el.label_text.lower()) is not None

    if not on_checkout_page:
        email_el = find(
            lambda el: el.label_text
            and "email" in el.label_text.lower()
            and el.semantic_token
            and el.element_id not in already_targeted
        )
        if email_el:
            return ActionInstruction(
                type="type",
                target_element_id=email_el.element_id,
                value=email_el.semantic_token,
                risk_tier="safe",
                reasoning_short="deterministic test: filling email field with its semantic token",
            )
        login_btn = find(lambda el: el.tag.lower() == "button" and el.label_text and "login" in el.label_text.lower())
        if login_btn and login_btn.element_id not in already_targeted:
            return ActionInstruction(
                type="click",
                target_element_id=login_btn.element_id,
                value=None,
                risk_tier="safe",
                reasoning_short="deterministic test: submitting login",
            )
    else:
        pay_btn = find(lambda el: el.tag.lower() == "button" and el.label_text and "pay" in el.label_text.lower())
        if pay_btn and pay_btn.element_id not in already_targeted:
            return ActionInstruction(
                type="click",
                target_element_id=pay_btn.element_id,
                value=None,
                risk_tier="safe",
                reasoning_short="deterministic test: submitting payment using the saved payment method",
            )

    return ActionInstruction(
        type="task_complete",
        target_element_id=None,
        value=None,
        risk_tier="safe",
        reasoning_short="deterministic test: nothing left to do",
    )


async def generate_action(payload: ClientPayload) -> ActionInstruction:
    if os.getenv("LLM_PROVIDER", "groq").lower() == "deterministic_test":
        logger.warning(
            "LLM_PROVIDER=deterministic_test is active — using the scripted "
            "test-only action generator, NOT the real Groq LLM. This must "
            "never be set for a demo."
        )
        return _generate_deterministic_test_action(payload)

    session = get_or_create_session(payload.session_id)
    history_context = session.get_context_string()

    # llama-3.3-70b-versatile was deprecated by Groq (confirmed live via
    # /v1/models during this integration pass — no longer returned).
    # openai/gpt-oss-120b is the currently-available default; still
    # overridable via MODEL_NAME.
    model_name = os.getenv("MODEL_NAME", "openai/gpt-oss-120b")
    client = get_llm_client()
    
    # Dev 2->Dev 3 integration fix: models tested against real traffic
    # (Groq's llama-3.3-70b-versatile is deprecated; openai/gpt-oss-20b and
    # -120b are the currently available replacements) reliably guessed a
    # plausible-but-wrong key name ("action" instead of "type") without a
    # concrete example, failing Pydantic validation 3/3 retries every time.
    # Adding the literal schema + a worked example fixed this consistently.
    system_prompt = """You are a highly capable browser automation agent.
Your task is to analyze the user's instruction and the current state of the webpage (DOM Summary) to determine the next action.

You MUST output your response as valid JSON with EXACTLY these keys (no other key names, no nesting):
{
  "type": "click" | "type" | "scroll" | "wait" | "ask_user_confirmation" | "task_complete" | "task_failed",
  "target_element_id": "<element_id from dom_summary, or null>",
  "value": "<text to type, or null — never a real sensitive value>",
  "risk_tier": "safe" | "risky",
  "reasoning_short": "<one short sentence>"
}

Example (typing into an email field with element_id "0.1"):
{"type": "type", "target_element_id": "0.1", "value": "[EMAIL_1]", "risk_tier": "safe", "reasoning_short": "Filling in the email field using its semantic token."}

IMPORTANT: You MUST NEVER output real sensitive values (passwords, card numbers, etc). If interacting with a sensitive field, use the provided `semantic_token` value exactly as given (e.g. "[EMAIL_1]"), never the real underlying value.
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
