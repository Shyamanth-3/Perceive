from app.session import get_or_create_session, clear_session
from app.models import ActionInstruction

def test_session_creation():
    session_id = "test-session-1"
    clear_session(session_id)
    
    session = get_or_create_session(session_id)
    assert session.session_id == session_id
    assert len(session.history) == 0

def test_session_history():
    session_id = "test-session-2"
    clear_session(session_id)
    session = get_or_create_session(session_id)
    
    action = ActionInstruction(
        type="click",
        target_element_id="btn-1",
        risk_tier="safe",
        reasoning_short="Testing"
    )
    
    session.add_step(1, "Click the button", action)
    assert len(session.history) == 1
    
    context = session.get_context_string()
    assert "Step 1" in context
    assert "Click the button" in context
    assert "click" in context
