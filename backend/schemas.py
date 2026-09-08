from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Literal
from enum import Enum

# --- Enums for strict validation ---
class SensitivityTier(str, Enum):
    TIER_1 = "1"
    TIER_2 = "2"
    TIER_3 = "3"

class SensitivityType(str, Enum):
    PASSWORD = "PASSWORD"
    CARD_NUMBER = "CARD_NUMBER"
    EMAIL = "EMAIL"
    NAME = "NAME"
    AMOUNT = "AMOUNT"
    UNKNOWN = "UNKNOWN"
    NONE = "NONE"

class DetectionMethod(str, Enum):
    DOM_HEURISTIC = "dom_heuristic"
    VISION_MODEL = "vision_model"
    OCR_REGEX = "ocr_regex"

class ActionType(str, Enum):
    CLICK = "click"
    TYPE = "type"
    SCROLL = "scroll"
    WAIT = "wait"
    ASK_USER_CONFIRMATION = "ask_user_confirmation"
    TASK_COMPLETE = "task_complete"
    TASK_FAILED = "task_failed"

class RiskTier(str, Enum):
    SAFE = "safe"
    RISKY = "risky"

# --- Client -> Server Payload (Section 4.1) ---
class BoundingBox(BaseModel):
    x: int; y: int; w: int; h: int

class DOMElement(BaseModel):
    element_id: str
    tag: str
    role: Optional[str] = None
    label_text: Optional[str] = None
    is_sensitive: bool
    sensitivity_tier: SensitivityTier
    sensitivity_type: SensitivityType
    semantic_token: Optional[str] = None
    bounding_box: Optional[BoundingBox] = None

class DOMSummary(BaseModel):
    url: str
    elements: List[DOMElement]

class DetectionNote(BaseModel):
    element_id: str
    confidence: float
    method: DetectionMethod

class ClientPayload(BaseModel):
    session_id: str
    task_instruction: str
    step_number: int
    dom_summary: DOMSummary
    redacted_image_base64: Optional[str] = None
    detection_confidence_notes: List[DetectionNote] = []

# --- Server -> Client Response (Section 4.2) ---
class Action(BaseModel):
    type: ActionType
    target_element_id: Optional[str] = None
    value: Optional[str] = None
    risk_tier: RiskTier
    reasoning_short: str

class ServerResponse(BaseModel):
    session_id: str
    step_number: int
    action: Action
    confidence: float

# --- Dev 5 Telemetry Payload ---
class TelemetryStage(BaseModel):
    stage_name: str
    duration_ms: float
    timestamp: float

class TelemetryPayload(BaseModel):
    session_id: str
    step_number: int
    stages: List[TelemetryStage]
    total_latency_ms: float