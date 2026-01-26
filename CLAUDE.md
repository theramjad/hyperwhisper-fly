# HyperWhisper Fly.io Transcription Service

Fly.io-based transcription proxy replacing Cloudflare Workers. Buffers audio in memory (no R2 needed).

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns region) |
| `/transcribe` | POST | Audio transcription |

## Deployment

### Deploy Changes

```bash
cd /Users/ray/Desktop/hyperwhisper/hyperwhisper-fly
fly deploy
```

### View Logs

```bash
fly logs
```

### Check Status

```bash
fly status
```

## Multi-Region Scaling

Currently deployed to 8 global regions:

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

### Add a New Region

Clone an existing machine to a new region:

```bash
fly machine clone <MACHINE_ID> --region <REGION_CODE>
```

Example:
```bash
fly machine clone 78175e4c19e448 --region bom  # Mumbai
```

### List Machines

```bash
fly machine list
```

### Remove a Region

```bash
fly machine destroy <MACHINE_ID>
```

## Secrets Management

### List Secrets

```bash
fly secrets list
```

### Set Secrets

```bash
fly secrets set KEY=value
```

### Required Secrets

| Secret | Description |
|--------|-------------|
| `DEEPGRAM_API_KEY` | Deepgram Nova-3 STT |
| `GROQ_API_KEY` | Groq Whisper STT |
| `ELEVENLABS_API_KEY` | ElevenLabs Scribe STT |
| `UPSTASH_REDIS_URL` | Upstash Redis URL |
| `UPSTASH_REDIS_TOKEN` | Upstash Redis token |
| `POLAR_API_KEY` | Polar license API |
| `NEXTJS_LICENSE_API_URL` | License validation endpoint |

### Rotate a Secret

```bash
fly secrets set DEEPGRAM_API_KEY=new_key_here
```

## Upstash Redis

Global Redis with read replicas matching Fly regions:

- **Primary**: US East (Virginia)
- **Read Replicas**: N. California, London, Frankfurt, Tokyo, Singapore, Sydney, São Paulo

Dashboard: https://console.upstash.com

## Monitoring

### Dashboard

https://fly.io/apps/hyperwhisper-transcribe/monitoring

### Tail Logs

```bash
fly logs --region sjc  # Specific region
fly logs               # All regions
```

### Test Health by Region

```bash
curl https://hyperwhisper-transcribe.fly.dev/health
```

## STT Providers

Selected via `X-STT-Provider` header:

| Provider | Header Value | Cost/min |
|----------|--------------|----------|
| Deepgram Nova-3 | `deepgram` (default) | $0.0043 |
| Groq Whisper | `groq` | $0.00185 |
| ElevenLabs Scribe | `elevenlabs` | $0.00983 |

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
