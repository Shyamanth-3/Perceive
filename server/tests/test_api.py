import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, AsyncMock
from app.main import app

client = TestClient(app)

def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

@patch('app.main.generate_action')
@patch('app.main.log_audit_event')
def test_analyze_endpoint_success(mock_log, mock_generate_action):
    # Mock the LLM generating a valid action
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="click",
        target_element_id="btn-submit",
        risk_tier="safe",
        reasoning_short="Submitting form"
    )
    
    payload = {
        "session_id": "api-session-1",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {
            "url": "http://test.com",
            "elements": [
                {
                    "element_id": "btn-submit",
                    "tag": "button",
                    "role": "button",
                    "is_sensitive": False,
                    "bounding_box": {"x": 10, "y": 10, "w": 100, "h": 50}
                }
            ]
        }
    }
    
    response = client.post("/analyze", json=payload)
    assert response.status_code == 200
    
    data = response.json()
    assert data["session_id"] == "api-session-1"
    assert data["step_number"] == 2
    assert data["action"]["type"] == "click"
    assert data["action"]["target_element_id"] == "btn-submit"
    
    # Check that audit log was called
    mock_log.assert_called_once()
    
@patch('app.main.generate_action')
def test_analyze_endpoint_validation_error(mock_generate_action):
    # Mock the LLM raising an exception after max retries
    from pydantic import ValidationError
    from app.models import ActionInstruction
    
    # We create a fake validation error
    class FakeError(ValueError):
        pass
        
    mock_generate_action.side_effect = FakeError("Mocked failure")
    
    payload = {
        "session_id": "api-session-2",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }
    
    response = client.post("/analyze", json=payload)
    assert response.status_code == 500
    assert "Mocked failure" in response.json()["detail"]
    assert mock_generate_action.call_count == 3  # MAX_RETRIES

@patch('app.main.log_audit_event')
@patch('app.main.generate_action')
def test_analyze_endpoint_rate_limit(mock_generate_action, mock_log):
    from groq import RateLimitError
    import httpx
    
    mock_generate_action.side_effect = RateLimitError(
        message="Rate limit exceeded",
        response=httpx.Response(status_code=429, request=httpx.Request("POST", "http://test")),
        body={"error": {"message": "rate limit"}}
    )
    
    payload = {
        "session_id": "api-session-rate",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }
    
    response = client.post("/analyze", json=payload)
    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "5"
    assert mock_generate_action.call_count == 1 # Does not retry blindly
    mock_log.assert_called_once()

@patch('app.main.log_audit_event')
def test_analyze_endpoint_session_continuity_fail(mock_log):
    payload = {
        "session_id": "api-session-fresh",
        "task_instruction": "submit form",
        "step_number": 3, # > 1 but no history
        "dom_summary": {"url": "http://test.com", "elements": []}
    }
    
    response = client.post("/analyze", json=payload)
    assert response.status_code == 400
    assert "no session history found" in response.json()["detail"]
    mock_log.assert_called_once()

@patch('app.main.generate_action')
@patch('app.main.log_audit_event')
def test_analyze_endpoint_session_continuity_retry_valid(mock_log, mock_generate_action):
    from app.models import ActionInstruction
    mock_generate_action.return_value = ActionInstruction(
        type="wait", risk_tier="safe", reasoning_short="waiting"
    )
    
    # First request works
    payload = {
        "session_id": "api-session-retry",
        "task_instruction": "submit form",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []}
    }
    response = client.post("/analyze", json=payload)
    assert response.status_code == 200
    
    # Client retries step 2 because the frontend failed to execute it
    payload["step_number"] = 2
    response2 = client.post("/analyze", json=payload)
    assert response2.status_code == 200 # Should succeed since session.history is populated

@patch('app.main.generate_action')
@patch('app.main.log_audit_event')
def test_analyze_endpoint_risk_tier_enforcement(mock_log, mock_generate_action):
    from app.models import ActionInstruction
    # LLM incorrectly marks action on sensitive field as 'safe'
    mock_generate_action.return_value = ActionInstruction(
        type="type",
        target_element_id="input-password",
        value="something",
        risk_tier="safe",
        reasoning_short="Typing into field"
    )
    
    payload = {
        "session_id": "api-session-risk",
        "task_instruction": "type password",
        "step_number": 1,
        "dom_summary": {
            "url": "http://test.com",
            "elements": [
                {
                    "element_id": "input-password",
                    "tag": "input",
                    "role": "textbox",
                    "is_sensitive": True, # Server should enforce risky
                    "sensitivity_tier": "1",
                    "sensitivity_type": "PASSWORD",
                    "semantic_token": "[PASSWORD]",
                    "bounding_box": {"x": 10, "y": 10, "w": 100, "h": 50}
                }
            ]
        }
    }
    
    response = client.post("/analyze", json=payload)
    assert response.status_code == 200
    assert response.json()["action"]["risk_tier"] == "risky"

@patch('app.main.generate_action')
def test_analyze_endpoint_hallucinated_target(mock_generate_action):
    from app.models import ActionInstruction
    # LLM returns a target_element_id that is not in the DOM summary
    mock_generate_action.return_value = ActionInstruction(
        type="click",
        target_element_id="fake-id",
        risk_tier="safe",
        reasoning_short="Clicking fake"
    )
    
    payload = {
        "session_id": "api-session-hallucinate",
        "task_instruction": "click fake",
        "step_number": 1,
        "dom_summary": {"url": "http://test.com", "elements": []} # Empty elements
    }
    
    response = client.post("/analyze", json=payload)
    # The server should catch the ValueError, retry 3 times, and fail with 500
    assert response.status_code == 500
    assert "fake-id" in response.json()["detail"]
    assert mock_generate_action.call_count == 3

