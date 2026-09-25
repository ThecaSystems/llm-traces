# Changelog

## 0.0.2 - 2026-09-25
- Interpret OTel GenAI role/parts messages and system instructions using the current semantic conventions
- Render reasoning, tool calls/results, and detailed token counts from OTel attributes
- Distinguish model inference from agent, workflow, tool, retrieval, embedding and memory operations
- Preserve structured OTLP arrays and maps; retain support for historical span formats
- Fork maintained by Theca Systems; original work and notices remain attributed to Agoda

## 0.0.1 - 2026-04-06
- Initial open-source release
- LLM trace visualization for OpenInference, OTel GenAI, and Vertex AI spans
- TraceQL query builder with LLM-specific filters
- Cost calculation based on token usage
- Resizable trace detail panels
