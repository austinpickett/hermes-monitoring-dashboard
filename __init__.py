"""Hermes Monitoring: a desktop surface backed by plugin-owned telemetry."""
from pathlib import Path


def register(ctx):
    """Register composition instructions; the API owns lazy native resources."""
    ctx.register_skill(
        "compose-monitoring-dashboard",
        Path(__file__).parent / "skills" / "compose-monitoring-dashboard" / "SKILL.md",
        description="Use when asked to create a blank dashboard, add a widget, or build a complete Monitoring dashboard.",
    )
