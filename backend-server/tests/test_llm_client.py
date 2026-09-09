import pytest
import os
from unittest.mock import AsyncMock, patch
from pydantic import ValidationError
from app.llm_client import generate_action
from app.models import ClientPayload, DOMSummary, ActionInstruction

@pytest.fixture
def mock_payload():
    return ClientPayload(
        session_id="test-session-3",
        task_instruction="Do something",
        step_number=1,
        dom_summary=DOMSummary(url="http://test.com", elements=[])
    )

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_success(mock_groq, mock_payload, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait", "risk_tier": "safe", "reasoning_short": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    action = await generate_action(mock_payload)
    assert action.type == "wait"
    assert action.risk_tier == "safe"

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_validation_error(mock_groq, mock_payload, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    # Invalid JSON schema: missing risk_tier and reasoning_short
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "wait"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    with pytest.raises(ValidationError):
        await generate_action(mock_payload)

@pytest.mark.asyncio
@patch('app.llm_client.AsyncGroq')
async def test_generate_action_offline_fallback(mock_groq, mock_payload, monkeypatch):
    # Simulate environment swap to offline
    monkeypatch.setenv("LLM_PROVIDER", "offline")
    monkeypatch.setenv("OFFLINE_API_BASE", "http://localhost:11434/v1")
    
    mock_client = mock_groq.return_value
    mock_response = AsyncMock()
    mock_response.choices = [
        AsyncMock(message=AsyncMock(content='{"type": "scroll", "risk_tier": "safe", "reasoning_short": "reading"}'))
    ]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    
    action = await generate_action(mock_payload)
    assert action.type == "scroll"
    
    # Check that client was created with the offline base_url instead of groq's default
    mock_groq.assert_called_with(api_key="offline-local", base_url="http://localhost:11434/v1")
