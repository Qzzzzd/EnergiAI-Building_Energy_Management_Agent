"""Shared V0.7 service errors."""


class SkillNotImplementedError(NotImplementedError):
    """Raised when a V0.7 placeholder service has no business implementation."""


class SkillNeedsInputError(ValueError):
    """Raised when parsing cannot safely continue without caller input."""


class SkillParseError(ValueError):
    """Raised when a source cannot be interpreted according to the parser rules."""
