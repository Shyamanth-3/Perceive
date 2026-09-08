from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from typing import Optional
from .models import ClientPayload, ServerResponse, ActionInstruction
from .llm_client import generate_action
from .session import get_or_create_session
from .logger import log_audit_event

app = FastAPI(title="Lightweight Browser Agent Backend")

MAX_RETRIES = 3

@app.post("/analyze", response_model=ServerResponse)
async def analyze_step(payload: ClientPayload):
    """
    Receives a sanitized payload, fetches session history,
    calls the reasoning LLM, and enforces ActionInstruction schema.
    Retries up to MAX_RETRIES on malformed LLM output.
    """
    session = get_or_create_session(payload.session_id)
    
    # Session continuity defense
    if payload.step_number > 1 and not session.history:
        log_audit_event(
            session_id=payload.session_id,
            step_number=payload.step_number,
            instruction=payload.task_instruction,
            action={"error": "Session continuity broken (fresh UUID mid-task)"},
            confidence=0.0,
            payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
        )
        raise HTTPException(
            status_code=400,
            detail="Step number > 1 but no session history found. Did the client regenerate session_id mid-task?"
        )
    
    last_exception: Optional[Exception] = None
    
    from groq import RateLimitError, APIError
    
    for attempt in range(MAX_RETRIES):
        try:
            # The LLM client already returns a Pydantic-validated ActionInstruction
            action = await generate_action(payload)
            
            # Additional semantic validation
            if action.target_element_id:
                valid_ids = [el.element_id for el in payload.dom_summary.elements]
                if action.target_element_id not in valid_ids:
                    raise ValueError(f"Hallucinated target_element_id '{action.target_element_id}'. Must be one of {valid_ids}")
                    
            # Server-authoritative risk tier override / enforcement
            # If it's a type action, or interacting with a sensitive field, ensure it's marked risky
            # This prevents a high-confidence LLM from silently bypassing the safety tier
            if action.target_element_id:
                target_el = next((el for el in payload.dom_summary.elements if el.element_id == action.target_element_id), None)
                if target_el and target_el.is_sensitive:
                    action.risk_tier = "risky"
            
            # Record step to session history
            session.add_step(payload.step_number, payload.task_instruction, action)
            
            # Log the event
            log_audit_event(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action=action.model_dump(),
                confidence=0.90,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            
            response = ServerResponse(
                session_id=payload.session_id,
                step_number=payload.step_number + 1,
                action=action,
                confidence=0.90 
            )
            return response
            
        except (ValueError, ValidationError) as ve:
            # Covers Pydantic ValidationError and our custom ValueError
            last_exception = ve
            continue
        except RateLimitError as e:
            # Don't blindly retry 429s in a tight loop
            log_audit_event(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action={"error": "Rate limit exceeded (429)"},
                confidence=0.0,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Please wait and try again."},
                headers={"Retry-After": "5"}
            )
        except Exception as e:
            # Other errors (e.g., API failures)
            log_audit_event(
                session_id=payload.session_id,
                step_number=payload.step_number,
                instruction=payload.task_instruction,
                action={"error": f"API Failure: {str(e)}"},
                confidence=0.0,
                payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
            )
            raise HTTPException(status_code=500, detail=str(e))
            
    # If we hit the max retries, fail
    error_msg = f"Failed to generate a valid action after {MAX_RETRIES} attempts. Last error: {str(last_exception)}"
    log_audit_event(
        session_id=payload.session_id,
        step_number=payload.step_number,
        instruction=payload.task_instruction,
        action={"error": error_msg},
        confidence=0.0,
        payload_notes=[n.model_dump() for n in payload.detection_confidence_notes]
    )
    raise HTTPException(
        status_code=500, 
        detail=error_msg
    )

@app.exception_handler(ValidationError)
async def validation_exception_handler(request: Request, exc: ValidationError):
    """Custom handler to ensure malformed incoming payloads are clearly rejected."""
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors(), "body": exc.body},
    )

@app.get("/health")
async def health_check():
    return {"status": "ok"}
