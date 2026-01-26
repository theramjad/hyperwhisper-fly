# HyperWhisper Fly.io Transcription Service (v2)

Fly.io-based transcription proxy replacing Cloudflare Workers. Buffers audio in memory (no R2 needed).

## Apps

| App | Purpose | Fly.io URL |
|-----|---------|------------|
| `hyperwhisper-transcribe` | Production | `https://hyperwhisper-transcribe.fly.dev` |
| `hyperwhisper-transcribe-dev` | Development | `https://hyperwhisper-transcribe-dev.fly.dev` |

## Custom Domains

| Environment | URL | App |
|-------------|-----|-----|
| Development | `https://transcribe-dev-v2.hyperwhisper.com` | `hyperwhisper-transcribe-dev` |
| Production | `https://transcribe-prod-v2.hyperwhisper.com` | `hyperwhisper-transcribe` |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns region) |
| `/transcribe` | POST | Audio transcription |
| `/post-process` | POST | Standalone LLM text correction |
| `/usage` | GET | Query credit balance + rate limits |
| `/ws/streaming-deepgram` | GET (WebSocket) | Real-time streaming transcription |

## Deployment

### Deploy to Production

```bash
cd /Users/ray/Desktop/hyperwhisper/hyperwhisper-fly
fly deploy --config fly.prod.toml
```

### Deploy to Development

```bash
cd /Users/ray/Desktop/hyperwhisper/hyperwhisper-fly
fly deploy --config fly.dev.toml
```

### View Logs

```bash
fly logs -a hyperwhisper-transcribe      # Production
fly logs -a hyperwhisper-transcribe-dev  # Development
```

### Check Status

```bash
fly status -a hyperwhisper-transcribe      # Production
fly status -a hyperwhisper-transcribe-dev  # Development
```

## Multi-Region Scaling (Production Only)

Production (`hyperwhisper-transcribe`) is deployed to 8 global regions. Development (`hyperwhisper-transcribe-dev`) runs in a single region (Tokyo/nrt).

| Region | Location |
|--------|----------|
| `sjc` | San Jose (US West) |
| `iad` | Virginia (US East) |
| `lhr` | London |
| `fra` | Frankfurt |
| `nrt` | Tokyo |
| `sin` | Singapore |
| `syd` | Sydney |
| `gru` | São Paulo |

### Add a New Region (Production)

Clone an existing machine to a new region:

```bash
fly machine clone <MACHINE_ID> --region <REGION_CODE> -a hyperwhisper-transcribe
```

Example:
```bash
fly machine clone 78175e4c19e448 --region bom -a hyperwhisper-transcribe  # Mumbai
```

### List Machines

```bash
fly machine list -a hyperwhisper-transcribe      # Production
fly machine list -a hyperwhisper-transcribe-dev  # Development
```

### Remove a Region

```bash
fly machine destroy <MACHINE_ID> -a hyperwhisper-transcribe
```

## Secrets Management

Both apps require the same secrets. Manage them separately for each app.

### List Secrets

```bash
fly secrets list -a hyperwhisper-transcribe      # Production
fly secrets list -a hyperwhisper-transcribe-dev  # Development
```

### Set Secrets

```bash
fly secrets set KEY=value -a hyperwhisper-transcribe      # Production
fly secrets set KEY=value -a hyperwhisper-transcribe-dev  # Development
```

### Required Secrets

| Secret | Description |
|--------|-------------|
| `DEEPGRAM_API_KEY` | Deepgram Nova-3 STT |
| `GROQ_API_KEY` | Groq Whisper STT + Groq LLM fallback |
| `ELEVENLABS_API_KEY` | ElevenLabs Scribe STT |
| `CEREBRAS_API_KEY` | Cerebras Llama 3.3 70B (post-processing default) |
| `UPSTASH_REDIS_URL` | Upstash Redis URL |
| `UPSTASH_REDIS_TOKEN` | Upstash Redis token |
| `NEXTJS_LICENSE_API_URL` | License validation endpoint |

### Rotate a Secret

```bash
fly secrets set DEEPGRAM_API_KEY=new_key_here -a hyperwhisper-transcribe      # Production
fly secrets set DEEPGRAM_API_KEY=new_key_here -a hyperwhisper-transcribe-dev  # Development
```

## Upstash Redis

Global Redis with read replicas matching Fly regions:

- **Primary**: US East (Virginia)
- **Read Replicas**: N. California, London, Frankfurt, Tokyo, Singapore, Sydney, São Paulo

Dashboard: https://console.upstash.com

## Monitoring

### Dashboard

- Production: https://fly.io/apps/hyperwhisper-transcribe/monitoring
- Development: https://fly.io/apps/hyperwhisper-transcribe-dev/monitoring

### Tail Logs

```bash
fly logs -a hyperwhisper-transcribe --region sjc  # Production, specific region
fly logs -a hyperwhisper-transcribe               # Production, all regions
fly logs -a hyperwhisper-transcribe-dev           # Development
```

### Test Health

```bash
curl https://transcribe-prod-v2.hyperwhisper.com/health  # Production
curl https://transcribe-dev-v2.hyperwhisper.com/health   # Development
```

## STT Providers

Selected via `X-STT-Provider` header:

| Provider | Header Value | Cost/min |
|----------|--------------|----------|
| Deepgram Nova-3 | `deepgram` (default) | $0.0055 |
| Groq Whisper | `groq` | $0.00185 |
| ElevenLabs Scribe | `elevenlabs` | $0.00983 |

## LLM Providers

Selected via `X-LLM-Provider` header (for `/post-process`):

| Provider | Header Value | Model | Input | Output |
|----------|--------------|-------|-------|--------|
| Cerebras | `cerebras` (default) | llama-3.3-70b | $0.85/1M | $1.20/1M |
| Groq | `groq` | llama-3.3-70b-versatile | $0.59/1M | $0.79/1M |

## Response Headers

- `X-Request-ID`: Unique request identifier
- `X-Total-Cost-Usd`: Cost in USD (6 decimal places)
- `X-Credits-Used`: Credits charged (1 decimal place)
- `X-STT-Provider`: Friendly STT provider name (e.g., `deepgram-nova3`)
- `X-LLM-Provider`: LLM provider name (for `/post-process`)

## Architecture

```
Client → Fly.io Anycast → Nearest Region → STT Provider → Response
                              ↓
                        Upstash Redis
                   (rate limits, credits, cache)
```

## Cost Estimate

| Component | Monthly |
|-----------|---------|
| 8x Fly machines (1GB, suspended when idle) | ~$15-30 |
| Upstash Redis (Global, free tier) | $0 |
| **Total** | ~$15-30/mo |
