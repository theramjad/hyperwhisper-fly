# Overview

The HyperWhisper Cloud service is built on Fly.io for global edge-based transcription with integrated credit management. Deployed across 17 regions worldwide for low-latency access.

# Commands
```bash
# Development
cd backend-v2-flyio && fly deploy --config fly.dev.toml

# Production
cd backend-v2-flyio && fly deploy --config fly.prod.toml
```

# References
- @references/custom-vocab.md - Use this when dealing with Deepgram custom vocabulary.
- Frontend Clients:
- - MacOS: `HyperWhisperCloudProvider.swift` → `buildInitialTranscriptionPrompt()`
- - Windows: 

# Deployment Environments

| Environment | URL | Fly App |
|-------------|-----|---------|
| Development | `transcribe-dev-v2.hyperwhisper.com` | `hyperwhisper-transcribe-dev` |
| Production | `transcribe-prod-v2.hyperwhisper.com` | `hyperwhisper-transcribe` |

# Architecture

```
Client → Fly.io Anycast → Nearest Region → Deepgram/Groq/ElevenLabs → Response
                              ↓
                        Upstash Redis
                   (rate limits, credits, license cache)
                              ↓
                     Next.js License API
```