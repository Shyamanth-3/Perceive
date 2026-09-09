import pytest
from pydantic import ValidationError
from app.models import ClientPayload, DOMSummary, DOMElement, ActionInstruction, ServerResponse, BoundingBox

def test_valid_client_payload():
    payload_data = {
        "session_id": "test-uuid-1234",
        "task_instruction": "book this event ticket",
        "step_number": 3,
        "dom_summary": {
            "url": "https://example.com/checkout",
            "elements": [
                {
                    "element_id": "card-input",
                    "tag": "input",
                    "role": "textbox",
                    "label_text": "Card Number",
                    "is_sensitive": True,
                    "sensitivity_tier": "1",
                    "sensitivity_type": "CARD_NUMBER",
                    "semantic_token": "[CARD_NUMBER]",
                    "bounding_box": {"x": 120, "y": 340, "w": 220, "h": 32}
                }
            ]
        },
        "detection_confidence_notes": [
            {"element_id": "card-input", "confidence": 0.92, "method": "dom_heuristic"}
        ]
    }
    
    payload = ClientPayload(**payload_data)
    assert payload.session_id == "test-uuid-1234"
    assert len(payload.dom_summary.elements) == 1
    assert payload.dom_summary.elements[0].semantic_token == "[CARD_NUMBER]"

def test_missing_required_fields_payload():
    with pytest.raises(ValidationError):
        # Missing session_id and dom_summary
        ClientPayload(task_instruction="test", step_number=1)

def test_action_instruction_type_validation():
    # Valid type action
    ActionInstruction(
        type="type",
        target_element_id="input-1",
        value="hello",
        risk_tier="safe",
        reasoning_short="Typing into search"
    )

    # Invalid: type action missing value
    with pytest.raises(ValidationError):
        ActionInstruction(
            type="type",
            target_element_id="input-1",
            risk_tier="safe",
            reasoning_short="Typing"
        )
        
    # Invalid: click action missing target
    with pytest.raises(ValidationError):
        ActionInstruction(
            type="click",
            risk_tier="safe",
            reasoning_short="Clicking without target"
        )

def test_server_response_validation():
    action = {
        "type": "wait",
        "risk_tier": "safe",
        "reasoning_short": "Waiting for load"
    }
    
    resp = ServerResponse(
        session_id="session-123",
        step_number=4,
        action=action,
        confidence=0.87
    )
    assert resp.action.type == "wait"

def test_llm_response_rejects_numeric_risk_tier():
    with pytest.raises(ValidationError):
        ActionInstruction(
            type="type",
            target_element_id="card-number-input",
            value="[CARD_NUMBER_1]",
            risk_tier=1,  # malformed — should be rejected, not coerced
            reasoning_short="test"
        )
