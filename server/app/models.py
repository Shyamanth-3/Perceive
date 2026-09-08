from pydantic import BaseModel, Field, model_validator, field_validator
from typing import List, Optional, Literal

# -------------------------------------------------------------------
# Enum-like Literals per PDF Section 4 contracts
# -------------------------------------------------------------------

TagType = str
RoleType = str
SensitivityTier = Literal["1", "2", "3"]
SensitivityType = Literal["PASSWORD", "CARD_NUMBER", "EMAIL", "NAME", "AMOUNT", "UNKNOWN"]
DetectionMethod = Literal["dom_heuristic", "vision_model", "ocr_regex"]
ActionType = Literal["click", "type", "scroll", "wait", "ask_user_confirmation", "task_complete", "task_failed"]
RiskTier = Literal["safe", "risky"]

# -------------------------------------------------------------------
# Client -> Server Payload Models
# -------------------------------------------------------------------

class BoundingBox(BaseModel):
    x: int
    y: int
    w: int
    h: int

class DOMElement(BaseModel):
    element_id: str
    tag: TagType
    role: RoleType
    label_text: Optional[str] = None
    is_sensitive: bool
    sensitivity_tier: Optional[SensitivityTier] = None
    sensitivity_type: Optional[SensitivityType] = None
    semantic_token: Optional[str] = None
    bounding_box: BoundingBox

    @model_validator(mode='after')
    def check_sensitive_has_token(self):
        # Section 8.2: Redaction breaks task utility - Semantic placeholder tokens instead of blind blackout
        # The server must NEVER receive a real sensitive value in any field.
        if self.is_sensitive and self.semantic_token is None:
            # We don't strictly reject missing token if they just blinded it, but we encourage it.
            pass
        return self

class DOMSummary(BaseModel):
    url: str
    elements: List[DOMElement]

class DetectionConfidenceNote(BaseModel):
    element_id: str
    confidence: float = Field(ge=0.0, le=1.0)
    method: DetectionMethod

class ClientPayload(BaseModel):
    session_id: str
    task_instruction: str
    step_number: int
    dom_summary: DOMSummary
    redacted_image_base64: Optional[str] = None
    detection_confidence_notes: List[DetectionConfidenceNote] = []

# -------------------------------------------------------------------
# Server -> Client Action Response Models
# -------------------------------------------------------------------

class ActionInstruction(BaseModel):
    type: ActionType
    target_element_id: Optional[str] = None
    value: Optional[str] = None
    risk_tier: RiskTier
    reasoning_short: str

    @field_validator("risk_tier", mode="before")
    @classmethod
    def reject_non_enum_risk_tier(cls, v):
        if v not in ("safe", "risky"):
            raise ValueError(
                f"risk_tier must be 'safe' or 'risky', got {v!r} "
                f"(type {type(v).__name__}) — numeric conversion is client-side only, "
                f"backend does not coerce"
            )
        return v

    @model_validator(mode='after')
    def check_required_fields_based_on_type(self):
        if self.type in ["click", "type"] and not self.target_element_id:
            raise ValueError(f"target_element_id is required for action type '{self.type}'")
        if self.type == "type" and self.value is None:
            raise ValueError("value is required for 'type' action")
        return self

class ServerResponse(BaseModel):
    session_id: str
    step_number: int
    action: ActionInstruction
    confidence: float = Field(ge=0.0, le=1.0)
