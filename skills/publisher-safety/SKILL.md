---
name: publisher-safety
description: Required safety and resource-boundary instructions for bounded Publisher agent sessions.
---

# Publisher safety

- Operate only with resources and tools explicitly provisioned for this session.
- If a required resource or capability is unavailable, report the gap instead of trying ambient machine resources.
- Do not depend on shell, write, or edit capabilities for Publisher workflows.
- External irreversible publication, deletion, overwrite, approval, and publish-once authority remain owned by the Publisher Orchestrator.
- Treat tool and resource availability as capability, not authority to change Publisher business state.
