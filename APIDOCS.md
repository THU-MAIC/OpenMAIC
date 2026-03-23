# pollinations.ai API

- **OpenAPI Version:** `3.1.0`
- **API Version:** `0.3.0`

Documentation for `gen.pollinations.ai` - the pollinations.ai API gateway.

[📝 Edit docs](https://github.com/pollinations/pollinations/edit/master/enter.pollinations.ai/src/routes/docs.ts)

## Quick Start

Get your API key at <https://enter.pollinations.ai>

### Image Generation

```bash
curl 'https://gen.pollinations.ai/image/a%20cat?model=flux' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

### Text Generation

```bash
curl 'https://gen.pollinations.ai/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model": "openai", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Vision (Image Input)

```bash
curl 'https://gen.pollinations.ai/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model": "openai", "messages": [{"role": "user", "content": [{"type": "text", "text": "Describe this image"}, {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}]}]}'
```

**Gemini Tools:** `gemini`, `gemini-large` have `code_execution` enabled (can generate images/plots). `gemini-search` has `google_search` enabled. Responses may include `content_blocks` with `image_url`, `text`, or `thinking` types.

### Simple Text Endpoint

```bash
curl 'https://gen.pollinations.ai/text/hello?key=YOUR_API_KEY'
```

### Streaming

```bash
curl 'https://gen.pollinations.ai/v1/chat/completions' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model": "openai", "messages": [{"role": "user", "content": "Write a poem"}], "stream": true}' \
  --no-buffer
```

### Model Discovery

**Always check available models before testing:**

- **Image models:** [/image/models](https://gen.pollinations.ai/image/models)
- **Text models:** [/v1/models](https://gen.pollinations.ai/v1/models)

## Authentication

**Two key types (both consume Pollen from your balance):**

- **Publishable Keys (`pk_`):** ⚠️ **Beta - not yet ready for production use.** For client-side apps, IP rate-limited (1 pollen per IP per hour). **Warning:** Exposing in public code will consume your Pollen if your app gets traffic.
- **Secret Keys (`sk_`):** Server-side only, no rate limits. Keep secret - never expose publicly.

**Auth methods:**

1. Header: `Authorization: Bearer YOUR_API_KEY`
2. Query param: `?key=YOUR_API_KEY`

## Account Management

Check your balance and usage:

```bash
# Check pollen balance
curl 'https://gen.pollinations.ai/account/balance' \
  -H 'Authorization: Bearer YOUR_API_KEY'

# Get profile info
curl 'https://gen.pollinations.ai/account/profile' \
  -H 'Authorization: Bearer YOUR_API_KEY'

# View usage history
curl 'https://gen.pollinations.ai/account/usage' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

## Servers

- **URL:** `https://gen.pollinations.ai`

## Operations

### GET /account/profile

- **Method:** `GET`
- **Path:** `/account/profile`
- **Tags:** gen.pollinations.ai

Get user profile info (name, email, GitHub username, tier, createdAt, nextResetAt). Requires `account:profile` permission for API keys.

#### Responses

##### Status: 200 User profile with name, email, githubUsername, tier, createdAt, nextResetAt

###### Content-Type: application/json

- **`createdAt` (required)**

  `string`, format: `date-time` — Account creation timestamp (ISO 8601)

- **`email` (required)**

  `object` — User's email address

- **`githubUsername` (required)**

  `object` — GitHub username if linked

- **`image` (required)**

  `object` — Profile picture URL (e.g. GitHub avatar)

- **`name` (required)**

  `object` — User's display name

- **`nextResetAt` (required)**

  `object` — Next daily pollen reset timestamp (ISO 8601)

- **`tier` (required)**

  `string`, possible values: `"anonymous", "microbe", "spore", "seed", "flower", "nectar", "router"` — User's current tier level

**Example:**

```json
{
  "name": "",
  "email": "",
  "githubUsername": "",
  "image": "",
  "tier": "anonymous",
  "createdAt": "",
  "nextResetAt": ""
}
```

##### Status: 401 Unauthorized

##### Status: 403 Permission denied - API key missing \`account:profile\` permission

### GET /account/balance

- **Method:** `GET`
- **Path:** `/account/balance`
- **Tags:** gen.pollinations.ai

Get pollen balance. Returns the key's remaining budget if set, otherwise the user's total balance. Requires `account:balance` permission for API keys.

#### Responses

##### Status: 200 Balance (remaining pollen)

###### Content-Type: application/json

- **`balance` (required)**

  `number` — Remaining pollen balance (combines tier, pack, and crypto balances)

**Example:**

```json
{
  "balance": 1
}
```

##### Status: 401 Unauthorized

##### Status: 403 Permission denied - API key missing \`account:balance\` permission

### GET /account/usage

- **Method:** `GET`
- **Path:** `/account/usage`
- **Tags:** gen.pollinations.ai

Get request history and spending data. Supports JSON and CSV formats. Requires `account:usage` permission for API keys.

#### Responses

##### Status: 200 Usage records with timestamp, model, tokens, cost\_usd, etc.

###### Content-Type: application/json

- **`count` (required)**

  `number` — Number of records returned

- **`usage` (required)**

  `array` — Array of usage records

  **Items:**

  - **`api_key` (required)**

    `object` — API key identifier used (masked)

  - **`api_key_type` (required)**

    `object` — Type of API key ('secret', 'publishable')

  - **`cost_usd` (required)**

    `number` — Cost in USD for this request

  - **`input_audio_tokens` (required)**

    `number` — Number of input audio tokens

  - **`input_cached_tokens` (required)**

    `number` — Number of cached input tokens

  - **`input_image_tokens` (required)**

    `number` — Number of input image tokens

  - **`input_text_tokens` (required)**

    `number` — Number of input text tokens

  - **`meter_source` (required)**

    `object` — Billing source ('tier', 'pack', 'crypto')

  - **`model` (required)**

    `object` — Model used for generation

  - **`output_audio_tokens` (required)**

    `number` — Number of output audio tokens

  - **`output_image_tokens` (required)**

    `number` — Number of output image tokens (1 per image)

  - **`output_reasoning_tokens` (required)**

    `number` — Number of reasoning tokens (for models with chain-of-thought)

  - **`output_text_tokens` (required)**

    `number` — Number of output text tokens

  - **`response_time_ms` (required)**

    `object` — Response time in milliseconds

  - **`timestamp` (required)**

    `string` — Request timestamp (YYYY-MM-DD HH:mm:ss format)

  - **`type` (required)**

    `string` — Request type (e.g., 'generate.image', 'generate.text')

**Example:**

```json
{
  "usage": [
    {
      "timestamp": "",
      "type": "",
      "model": "",
      "api_key": "",
      "api_key_type": "",
      "meter_source": "",
      "input_text_tokens": 1,
      "input_cached_tokens": 1,
      "input_audio_tokens": 1,
      "input_image_tokens": 1,
      "output_text_tokens": 1,
      "output_reasoning_tokens": 1,
      "output_audio_tokens": 1,
      "output_image_tokens": 1,
      "cost_usd": 1,
      "response_time_ms": 1
    }
  ],
  "count": 1
}
```

##### Status: 401 Unauthorized

##### Status: 403 Permission denied - API key missing \`account:usage\` permission

### GET /account/usage/daily

- **Method:** `GET`
- **Path:** `/account/usage/daily`
- **Tags:** gen.pollinations.ai

Get daily aggregated usage data (last 90 days). Supports JSON and CSV formats. Requires `account:usage` permission for API keys. Results are cached for 1 hour.

#### Responses

##### Status: 200 Daily usage records aggregated by date/model

###### Content-Type: application/json

- **`count` (required)**

  `number` — Number of records returned

- **`usage` (required)**

  `array` — Array of daily usage records

  **Items:**

  - **`cost_usd` (required)**

    `number` — Total cost in USD

  - **`date` (required)**

    `string` — Date (YYYY-MM-DD format)

  - **`meter_source` (required)**

    `object` — Billing source ('tier', 'pack', 'crypto')

  - **`model` (required)**

    `object` — Model used

  - **`requests` (required)**

    `number` — Number of requests

**Example:**

```json
{
  "usage": [
    {
      "date": "",
      "model": "",
      "meter_source": "",
      "requests": 1,
      "cost_usd": 1
    }
  ],
  "count": 1
}
```

##### Status: 401 Unauthorized

##### Status: 403 Permission denied - API key missing \`account:usage\` permission

### GET /account/key

- **Method:** `GET`
- **Path:** `/account/key`
- **Tags:** gen.pollinations.ai

Get API key status and information. Returns key validity, type, expiry, permissions, and remaining budget. This endpoint allows validating keys without making expensive generation requests. Requires API key authentication.

#### Responses

##### Status: 200 API key status and information

###### Content-Type: application/json

- **`expiresAt` (required)**

  `object` — Expiry timestamp in ISO 8601 format, null if never expires

- **`expiresIn` (required)**

  `object` — Seconds until expiry, null if never expires

- **`name` (required)**

  `object` — Display name of the API key

- **`permissions` (required)**

  `object` — API key permissions

  - **`account` (required)**

    `object` — List of account permissions, null = no account access

  - **`models` (required)**

    `object` — List of allowed model IDs, null = all models allowed

- **`pollenBudget` (required)**

  `object` — Remaining pollen budget for this key, null = unlimited (uses user balance)

- **`rateLimitEnabled` (required)**

  `boolean` — Whether rate limiting is enabled for this key

- **`type` (required)**

  `string`, possible values: `"publishable", "secret"` — Type of API key

- **`valid` (required)**

  `boolean` — Whether the API key is valid and active

**Example:**

```json
{
  "valid": true,
  "type": "publishable",
  "name": "",
  "expiresAt": "",
  "expiresIn": 1,
  "permissions": {
    "models": [
      ""
    ],
    "account": [
      ""
    ]
  },
  "pollenBudget": 1,
  "rateLimitEnabled": true
}
```

##### Status: 401 Invalid or missing API key

### GET /v1/models

- **Method:** `GET`
- **Path:** `/v1/models`
- **Tags:** gen.pollinations.ai

Get available text models (OpenAI-compatible). If an API key with model restrictions is provided, only allowed models are returned.

#### Responses

##### Status: 200 Success

###### Content-Type: application/json

- **`data` (required)**

  `array`

  **Items:**

  - **`created` (required)**

    `number`

  - **`id` (required)**

    `string`

  - **`object` (required)**

    `string`

- **`object` (required)**

  `string`

**Example:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "",
      "object": "model",
      "created": 1
    }
  ]
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /image/models

- **Method:** `GET`
- **Path:** `/image/models`
- **Tags:** gen.pollinations.ai

Get a list of available image generation models with pricing, capabilities, and metadata. If an API key with model restrictions is provided, only allowed models are returned.

#### Responses

##### Status: 200 Success

###### Content-Type: application/json

**Array of:**

**Example:**

```json
[]
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /text/models

- **Method:** `GET`
- **Path:** `/text/models`
- **Tags:** gen.pollinations.ai

Get a list of available text generation models with pricing, capabilities, and metadata. If an API key with model restrictions is provided, only allowed models are returned.

#### Responses

##### Status: 200 Success

###### Content-Type: application/json

**Array of:**

**Example:**

```json
[]
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /audio/models

- **Method:** `GET`
- **Path:** `/audio/models`
- **Tags:** gen.pollinations.ai

Get a list of available audio models with pricing, capabilities, and metadata. If an API key with model restrictions is provided, only allowed models are returned.

#### Responses

##### Status: 200 Success

###### Content-Type: application/json

**Array of:**

**Example:**

```json
[]
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### POST /v1/chat/completions

- **Method:** `POST`
- **Path:** `/v1/chat/completions`
- **Tags:** gen.pollinations.ai

OpenAI-compatible chat completions endpoint.

**Legacy endpoint:** `/openai` (deprecated, use `/v1/chat/completions` instead)

**Authentication (Secret Keys Only):**

Include your API key in the `Authorization` header as a Bearer token:

`Authorization: Bearer YOUR_API_KEY`

API keys can be created from your dashboard at enter.pollinations.ai. Both key types consume Pollen. Secret keys have no rate limits.

#### Request Body

##### Content-Type: application/json

- **`messages` (required)**

  `array`

  **Items:**

  **Any of:**

  - **`content` (required)**

    `object`

  - **`role` (required)**

    `string`

  - **`cache_control`**

    `object`

    - **`type` (required)**

      `string`, possible values: `"ephemeral"`

  - **`name`**

    `string`

  * **`content` (required)**

    `object`

  * **`role` (required)**

    `string`

  * **`cache_control`**

    `object`

    - **`type` (required)**

      `string`, possible values: `"ephemeral"`

  * **`name`**

    `string`

  - **`content` (required)**

    `object`

  - **`role` (required)**

    `string`

  - **`name`**

    `string`

  * **`role` (required)**

    `string`

  * **`cache_control`**

    `object`

    - **`type` (required)**

      `string`, possible values: `"ephemeral"`

  * **`content`**

    `object`

  * **`function_call`**

    `object`

  * **`name`**

    `string`

  * **`tool_calls`**

    `array`

    **Items:**

    - **`function` (required)**

      `object`

      - **`arguments` (required)**

        `string`

      - **`name` (required)**

        `string`

    - **`id` (required)**

      `string`

    - **`type` (required)**

      `string`

  - **`content` (required)**

    `object`

  - **`role` (required)**

    `string`

  - **`tool_call_id` (required)**

    `string`

  - **`cache_control`**

    `object`

    - **`type` (required)**

      `string`, possible values: `"ephemeral"`

  * **`content` (required)**

    `object`

  * **`name` (required)**

    `string`

  * **`role` (required)**

    `string`

- **`audio`**

  `object`

  - **`format` (required)**

    `string`, possible values: `"wav", "mp3", "flac", "opus", "pcm16"`

  - **`voice` (required)**

    `string`, possible values: `"alloy", "echo", "fable", "onyx", "shimmer", "coral", "verse", "ballad", "ash", "sage", "amuch", "dan"`

- **`frequency_penalty`**

  `object`, default: `0`

- **`function_call`**

  `object`

- **`functions`**

  `array`

  **Items:**

  - **`name` (required)**

    `string`

  - **`description`**

    `string`

  - **`parameters`**

    `object`

- **`logit_bias`**

  `object`, default: `null`

- **`logprobs`**

  `object`, default: `false`

- **`max_tokens`**

  `object`

- **`modalities`**

  `array`

  **Items:**

  `string`, possible values: `"text", "audio"`

- **`model`**

  `string`, default: `"openai"` — AI model for text generation. See /v1/models for full list.

- **`parallel_tool_calls`**

  `boolean`, default: `true`

- **`presence_penalty`**

  `object`, default: `0`

- **`reasoning_effort`**

  `string`, possible values: `"none", "minimal", "low", "medium", "high", "xhigh"`

- **`repetition_penalty`**

  `object`

- **`response_format`**

  `object`

- **`seed`**

  `object`

- **`stop`**

  `object`

- **`stream`**

  `object`, default: `false`

- **`stream_options`**

  `object`

- **`temperature`**

  `object`, default: `1`

- **`thinking`**

  `object`

- **`thinking_budget`**

  `integer`

- **`tool_choice`**

  `object`

- **`tools`**

  `array`

  **Items:**

  **Any of:**

  - **`function` (required)**

    `object`

    - **`name` (required)**

      `string`

    - **`description`**

      `string`

    - **`parameters`**

      `object`

    - **`strict`**

      `object`, default: `false`

  - **`type` (required)**

    `string`

  * **`type` (required)**

    `string`, possible values: `"code_execution", "google_search", "google_maps", "url_context", "computer_use", "file_search"`

- **`top_logprobs`**

  `object`

- **`top_p`**

  `object`, default: `1`

- **`user`**

  `string`

**Example:**

```json
{
  "messages": [
    {
      "content": "",
      "role": "system",
      "name": "",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "model": "openai",
  "modalities": [
    "text"
  ],
  "audio": {
    "voice": "alloy",
    "format": "wav"
  },
  "frequency_penalty": 0,
  "repetition_penalty": 0,
  "logit_bias": null,
  "logprobs": false,
  "top_logprobs": 0,
  "max_tokens": 0,
  "presence_penalty": 0,
  "response_format": {
    "type": "text"
  },
  "seed": -1,
  "stop": "",
  "stream": false,
  "stream_options": {
    "include_usage": true
  },
  "thinking": {
    "type": "disabled",
    "budget_tokens": 1
  },
  "reasoning_effort": "none",
  "thinking_budget": 0,
  "temperature": 1,
  "top_p": 1,
  "tools": [
    {
      "type": "function",
      "function": {
        "description": "",
        "name": "",
        "parameters": {
          "propertyName*": "anything"
        },
        "strict": false
      }
    }
  ],
  "tool_choice": "none",
  "parallel_tool_calls": true,
  "user": "",
  "function_call": "none",
  "functions": [
    {
      "description": "",
      "name": "",
      "parameters": {
        "propertyName*": "anything"
      }
    }
  ]
}
```

#### Responses

##### Status: 200 Success

###### Content-Type: application/json

- **`choices` (required)**

  `array`

  **Items:**

  - **`content_filter_results`**

    `object`

  - **`finish_reason`**

    `object`

  - **`index`**

    `integer`

  - **`logprobs`**

    `object`

  - **`message`**

    `object`

    - **`role` (required)**

      `string`

    - **`audio`**

      `object`

    - **`content`**

      `object`

    - **`content_blocks`**

      `object`

    - **`function_call`**

      `object`

    - **`reasoning_content`**

      `object`

    - **`tool_calls`**

      `object`

- **`created` (required)**

  `integer`

- **`id` (required)**

  `string`

- **`model` (required)**

  `string`

- **`object` (required)**

  `string`

- **`usage` (required)**

  `object`

- **`citations`**

  `array`

  **Items:**

  `string`

- **`prompt_filter_results`**

  `object`

- **`system_fingerprint`**

  `object`

- **`user_tier`**

  `string`, possible values: `"anonymous", "seed", "flower", "nectar"`

**Example:**

```json
{
  "id": "",
  "choices": [
    {
      "finish_reason": "",
      "index": 0,
      "message": {
        "content": "",
        "tool_calls": [
          {
            "id": "",
            "type": "function",
            "function": {
              "name": "",
              "arguments": ""
            }
          }
        ],
        "role": "assistant",
        "function_call": {
          "arguments": "",
          "name": ""
        },
        "content_blocks": [
          {
            "type": "text",
            "text": "",
            "cache_control": {
              "type": "ephemeral"
            }
          }
        ],
        "audio": {
          "transcript": "",
          "data": "",
          "id": "",
          "expires_at": -9007199254740991
        },
        "reasoning_content": ""
      },
      "logprobs": {
        "content": [
          {
            "token": "",
            "logprob": 1,
            "bytes": [
              "[Max Depth Exceeded]"
            ],
            "top_logprobs": [
              {
                "token": "[Max Depth Exceeded]",
                "logprob": "[Max Depth Exceeded]",
                "bytes": "[Max Depth Exceeded]"
              }
            ]
          }
        ]
      },
      "content_filter_results": null
    }
  ],
  "prompt_filter_results": [
    {
      "prompt_index": 0
    }
  ],
  "created": -9007199254740991,
  "model": "",
  "system_fingerprint": "",
  "object": "chat.completion",
  "user_tier": "anonymous",
  "citations": [
    ""
  ]
}
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 402 Insufficient pollen balance or API key budget exhausted.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 402,
  "success": false,
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Insufficient pollen balance or API key budget exhausted.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 403 Access denied! You don't have the required permissions for this resource or model.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 403,
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied! You don't have the required permissions for this resource or model.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /text/{prompt}

- **Method:** `GET`
- **Path:** `/text/{prompt}`
- **Tags:** gen.pollinations.ai

Generates text from text prompts.

**Authentication:**

Include your API key either:

- In the `Authorization` header as a Bearer token: `Authorization: Bearer YOUR_API_KEY`
- As a query parameter: `?key=YOUR_API_KEY`

API keys can be created from your dashboard at enter.pollinations.ai.

#### Responses

##### Status: 200 Generated text response

###### Content-Type: text/plain

`string`

**Example:**

```json
true
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 402 Insufficient pollen balance or API key budget exhausted.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 402,
  "success": false,
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Insufficient pollen balance or API key budget exhausted.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 403 Access denied! You don't have the required permissions for this resource or model.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 403,
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied! You don't have the required permissions for this resource or model.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /image/{prompt}

- **Method:** `GET`
- **Path:** `/image/{prompt}`
- **Tags:** gen.pollinations.ai

Generate an image or video from a text prompt.

**Image Models:** `flux` (default), `turbo`, `gptimage`, `kontext`, `seedream`, `nanobanana`, `nanobanana-pro`

**Video Models:** `veo`, `seedance`

- `veo`: Text-to-video only (4-8 seconds)
- `seedance`: Text-to-video and image-to-video (2-10 seconds)

**Authentication:**

Include your API key either:

- In the `Authorization` header as a Bearer token: `Authorization: Bearer YOUR_API_KEY`
- As a query parameter: `?key=YOUR_API_KEY`

API keys can be created from your dashboard at enter.pollinations.ai.

#### Responses

##### Status: 200 Success - Returns the generated image or video

###### Content-Type: image/jpeg

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: image/png

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: video/mp4

`string`, format: `binary`

**Example:**

```json
{}
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 402 Insufficient pollen balance or API key budget exhausted.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 402,
  "success": false,
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Insufficient pollen balance or API key budget exhausted.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 403 Access denied! You don't have the required permissions for this resource or model.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 403,
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied! You don't have the required permissions for this resource or model.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### GET /audio/{text}

- **Method:** `GET`
- **Path:** `/audio/{text}`
- **Tags:** gen.pollinations.ai

Generate audio from text — speech (TTS) or music.

**Models:** Use `model` query param to select:

- TTS (default): `elevenlabs`, `tts-1`, etc.
- Music: `elevenmusic` (or `music`)

**TTS Voices:** alloy, echo, fable, onyx, nova, shimmer, ash, ballad, coral, sage, verse, rachel, domi, bella, elli, charlotte, dorothy, sarah, emily, lily, matilda, adam, antoni, arnold, josh, sam, daniel, charlie, james, fin, callum, liam, george, brian, bill

**Output Formats (TTS only):** mp3, opus, aac, flac, wav, pcm

**Music options:** `duration` in seconds (3-300), `instrumental=true`

**Authentication:**

Include your API key either:

- In the `Authorization` header as a Bearer token: `Authorization: Bearer YOUR_API_KEY`
- As a query parameter: `?key=YOUR_API_KEY`

API keys can be created from your dashboard at enter.pollinations.ai.

#### Responses

##### Status: 200 Success - Returns audio data

###### Content-Type: audio/mpeg

`string`, format: `binary`

**Example:**

```json
{}
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 402 Insufficient pollen balance or API key budget exhausted.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 402,
  "success": false,
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "Insufficient pollen balance or API key budget exhausted.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 403 Access denied! You don't have the required permissions for this resource or model.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 403,
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied! You don't have the required permissions for this resource or model.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### POST /v1/audio/speech

- **Method:** `POST`
- **Path:** `/v1/audio/speech`
- **Tags:** gen.pollinations.ai

Generate audio from text — speech (TTS) or music.

This endpoint is OpenAI TTS API compatible. Set `model` to `elevenmusic` (or alias `music`) to generate music instead of speech.

**TTS Voices:** alloy, echo, fable, onyx, nova, shimmer, ash, ballad, coral, sage, verse, rachel, domi, bella, elli, charlotte, dorothy, sarah, emily, lily, matilda, adam, antoni, arnold, josh, sam, daniel, charlie, james, fin, callum, liam, george, brian, bill

**Output Formats (TTS only):** mp3, opus, aac, flac, wav, pcm

#### Request Body

##### Content-Type: application/json

- **`input` (required)**

  `string` — The text to generate audio for. Maximum 4096 characters.

- **`duration`**

  `number` — Music duration in seconds, 3-300 (elevenmusic only)

- **`instrumental`**

  `boolean` — If true, guarantees instrumental output (elevenmusic only)

- **`model`**

  `string`

- **`response_format`**

  `string`, possible values: `"mp3", "opus", "aac", "flac", "wav", "pcm"`, default: `"mp3"` — The audio format for the output.

- **`speed`**

  `number`, default: `1` — The speed of the generated audio. 0.25 to 4.0, default 1.0.

- **`voice`**

  `string`, default: `"alloy"` — The voice to use. Can be any preset name (alloy, echo, fable, onyx, nova, shimmer, ash, ballad, coral, sage, verse, rachel, domi, bella, elli, charlotte, dorothy, sarah, emily, lily, matilda, adam, antoni, arnold, josh, sam, daniel, charlie, james, fin, callum, liam, george, brian, bill) OR a custom ElevenLabs voice ID (UUID from your dashboard).

**Example:**

```json
{
  "model": "",
  "input": "Hello, welcome to Pollinations!",
  "voice": "rachel",
  "response_format": "mp3",
  "speed": 1,
  "duration": 30,
  "instrumental": false
}
```

#### Responses

##### Status: 200 Success - Returns audio data

###### Content-Type: audio/mpeg

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: audio/opus

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: audio/aac

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: audio/flac

`string`, format: `binary`

**Example:**

```json
{}
```

###### Content-Type: audio/wav

`string`, format: `binary`

**Example:**

```json
{}
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### POST /v1/audio/transcriptions

- **Method:** `POST`
- **Path:** `/v1/audio/transcriptions`
- **Tags:** gen.pollinations.ai

Transcribe audio to text using Whisper or ElevenLabs Scribe.

This endpoint is OpenAI Whisper API compatible.

**Supported formats:** mp3, mp4, mpeg, mpga, m4a, wav, webm

**Models:** `whisper-large-v3` (default), `whisper-1`, `scribe`

#### Request Body

##### Content-Type: multipart/form-data

- **`file` (required)**

  `string`, format: `binary` — The audio file to transcribe. Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm.

- **`language`**

  `string` — Language of the audio in ISO-639-1 format (e.g. \`en\`, \`fr\`). Improves accuracy.

- **`model`**

  `string`, default: `"whisper-large-v3"` — The model to use. Options: \`whisper-large-v3\`, \`whisper-1\`, \`scribe\`.

- **`prompt`**

  `string` — Optional text to guide the model's style or continue a previous segment.

- **`response_format`**

  `string`, possible values: `"json", "text", "srt", "verbose_json", "vtt"`, default: `"json"` — The format of the transcript output.

- **`temperature`**

  `number` — Sampling temperature between 0 and 1. Lower is more deterministic.

**Example:**

```json
{
  "file": {},
  "model": "whisper-large-v3",
  "language": "",
  "prompt": "",
  "response_format": "json",
  "temperature": 1
}
```

#### Responses

##### Status: 200 Success - Returns transcription

###### Content-Type: application/json

- **`text`**

  `string`

**Example:**

```json
{
  "text": ""
}
```

##### Status: 400 Something was wrong with the input data, check the details for more info.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 400,
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Something was wrong with the input data, check the details for more info.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 401 Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 401,
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required. Please provide an API key via Authorization header (Bearer token) or ?key= query parameter.",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

##### Status: 500 Oh snap, something went wrong on our end. We're on it!

###### Content-Type: application/json

- **`error` (required)**

  `object`

  - **`code` (required)**

    `string`

  - **`details` (required)**

    `object`

  - **`message` (required)**

    `object`

  - **`timestamp` (required)**

    `string`

  - **`cause`**

    `object`

  - **`requestId`**

    `string`

- **`status` (required)**

  `number`

- **`success` (required)**

  `boolean`

**Example:**

```json
{
  "status": 500,
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Oh snap, something went wrong on our end. We're on it!",
    "timestamp": "",
    "requestId": "",
    "cause": null
  }
}
```

### Upload media

- **Method:** `POST`
- **Path:** `/upload`
- **Tags:** media.pollinations.ai

Upload an image, audio, or video file. Supports multipart/form-data, raw binary, or base64 JSON. Returns a content-addressed hash URL. Duplicate files return the existing hash.

#### Responses

##### Status: 200 Upload successful

###### Content-Type: application/json

- **`contentType` (required)**

  `string`

- **`duplicate` (required)**

  `boolean`

- **`id` (required)**

  `string`

- **`size` (required)**

  `integer`

- **`url` (required)**

  `string`

**Example:**

```json
{
  "id": "",
  "url": "",
  "contentType": "",
  "size": 1,
  "duplicate": true
}
```

##### Status: 401 Missing or invalid API key

###### Content-Type: application/json

- **`error` (required)**

  `string`

**Example:**

```json
{
  "error": ""
}
```

##### Status: 413 File too large (max 10MB)

###### Content-Type: application/json

- **`error` (required)**

  `string`

**Example:**

```json
{
  "error": ""
}
```

##### Status: 415 Unsupported media type

###### Content-Type: application/json

- **`error` (required)**

  `string`

**Example:**

```json
{
  "error": ""
}
```

### SERVERS /upload

- **Method:** `SERVERS`
- **Path:** `/upload`

### Retrieve media

- **Method:** `GET`
- **Path:** `/{hash}`
- **Tags:** media.pollinations.ai

Get a file by its content hash. No authentication required. Responses are cached immutably.

#### Responses

##### Status: 200 File content with appropriate Content-Type

##### Status: 400 Invalid hash format

###### Content-Type: application/json

- **`error` (required)**

  `string`

**Example:**

```json
{
  "error": ""
}
```

##### Status: 404 File not found

###### Content-Type: application/json

- **`error` (required)**

  `string`

**Example:**

```json
{
  "error": ""
}
```

### Check if media exists

- **Method:** `HEAD`
- **Path:** `/{hash}`
- **Tags:** media.pollinations.ai

Check existence and metadata without downloading the file.

#### Responses

##### Status: 200 File exists (headers include Content-Type, Content-Length, X-Content-Hash)

##### Status: 400 Invalid hash format

##### Status: 404 File not found

### SERVERS /{hash}

- **Method:** `SERVERS`
- **Path:** `/{hash}`

## Schemas

### CacheControl

- **Type:**`object`

* **`type` (required)**

  `string`, possible values: `"ephemeral"`

**Example:**

```json
{
  "type": "ephemeral"
}
```

### MessageContentPart

- **Type:**

**Example:**

### CreateSpeechRequest

- **Type:**`object`

* **`input` (required)**

  `string` — The text to generate audio for. Maximum 4096 characters.

* **`duration`**

  `number` — Music duration in seconds, 3-300 (elevenmusic only)

* **`instrumental`**

  `boolean` — If true, guarantees instrumental output (elevenmusic only)

* **`model`**

  `string`

* **`response_format`**

  `string`, possible values: `"mp3", "opus", "aac", "flac", "wav", "pcm"`, default: `"mp3"` — The audio format for the output.

* **`speed`**

  `number`, default: `1` — The speed of the generated audio. 0.25 to 4.0, default 1.0.

* **`voice`**

  `string`, default: `"alloy"` — The voice to use. Can be any preset name (alloy, echo, fable, onyx, nova, shimmer, ash, ballad, coral, sage, verse, rachel, domi, bella, elli, charlotte, dorothy, sarah, emily, lily, matilda, adam, antoni, arnold, josh, sam, daniel, charlie, james, fin, callum, liam, george, brian, bill) OR a custom ElevenLabs voice ID (UUID from your dashboard).

**Example:**

```json
{
  "model": "",
  "input": "Hello, welcome to Pollinations!",
  "voice": "rachel",
  "response_format": "mp3",
  "speed": 1,
  "duration": 30,
  "instrumental": false
}
```
