const { Telemetry } = require("../../models/telemetry");
const { resetAllVectorStores } = require("../vectorStore/resetAllVectorStores");
const { emitAuditEvent } = require("../events");

const KEY_MAPPING = {
  LLMProvider: {
    envKey: "LLM_PROVIDER",
    secret: false,
    checks: [isNotEmpty, supportedLLM],
  },
  // Model Router Settings
  ModelRouterId: {
    envKey: "MODEL_ROUTER_ID",
    secret: false,
    checks: [],
  },
  // OpenAI Settings
  OpenAiKey: {
    envKey: "OPEN_AI_KEY",
    secret: true,
    checks: [isNotEmpty, validOpenAIKey],
  },
  OpenAiModelPref: {
    envKey: "OPEN_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  // Azure OpenAI Settings
  AzureOpenAiEndpoint: {
    envKey: "AZURE_OPENAI_ENDPOINT",
    secret: "url",
    checks: [isNotEmpty],
  },
  AzureOpenAiTokenLimit: {
    envKey: "AZURE_OPENAI_TOKEN_LIMIT",
    secret: true,
    checks: [validOpenAiTokenLimit],
  },
  AzureOpenAiKey: {
    envKey: "AZURE_OPENAI_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  AzureOpenAiModelPref: {
    envKey: "AZURE_OPENAI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  AzureOpenAiEmbeddingModelPref: {
    envKey: "EMBEDDING_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  AzureOpenAiModelType: {
    envKey: "AZURE_OPENAI_MODEL_TYPE",
    secret: false,
    checks: [
      (input) =>
        ["default", "reasoning"].includes(input)
          ? null
          : "Invalid model type. Must be one of: default, reasoning.",
    ],
  },

  // Anthropic Settings
  AnthropicApiKey: {
    envKey: "ANTHROPIC_API_KEY",
    secret: true,
    checks: [isNotEmpty, validAnthropicApiKey],
  },
  AnthropicModelPref: {
    envKey: "ANTHROPIC_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  AnthropicCacheControl: {
    envKey: "ANTHROPIC_CACHE_CONTROL",
    secret: false,
    checks: [
      (input) =>
        ["none", "5m", "1h"].includes(input)
          ? null
          : "Invalid cache control. Must be one of: 5m, 1h.",
    ],
  },

  GeminiLLMApiKey: {
    envKey: "GEMINI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  GeminiLLMModelPref: {
    envKey: "GEMINI_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  GeminiSafetySetting: {
    envKey: "GEMINI_SAFETY_SETTING",
    secret: false,
    checks: [validGeminiSafetySetting],
  },

  // LMStudio Settings
  LMStudioBasePath: {
    envKey: "LMSTUDIO_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validLLMExternalBasePath, validDockerizedUrl],
  },
  LMStudioModelPref: {
    envKey: "LMSTUDIO_MODEL_PREF",
    secret: false,
    checks: [],
  },
  LMStudioTokenLimit: {
    envKey: "LMSTUDIO_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },
  LMStudioAuthToken: {
    envKey: "LMSTUDIO_AUTH_TOKEN",
    secret: true,
    checks: [],
  },

  // LocalAI Settings
  LocalAiBasePath: {
    envKey: "LOCAL_AI_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validLLMExternalBasePath, validDockerizedUrl],
  },
  LocalAiModelPref: {
    envKey: "LOCAL_AI_MODEL_PREF",
    secret: false,
    checks: [],
  },
  LocalAiTokenLimit: {
    envKey: "LOCAL_AI_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },
  LocalAiApiKey: {
    envKey: "LOCAL_AI_API_KEY",
    secret: true,
    checks: [],
  },

  OllamaLLMBasePath: {
    envKey: "OLLAMA_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validOllamaLLMBasePath, validDockerizedUrl],
  },
  OllamaLLMModelPref: {
    envKey: "OLLAMA_MODEL_PREF",
    secret: false,
    checks: [],
  },
  OllamaLLMTokenLimit: {
    envKey: "OLLAMA_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },
  OllamaLLMKeepAliveSeconds: {
    envKey: "OLLAMA_KEEP_ALIVE_TIMEOUT",
    secret: false,
    checks: [isInteger],
  },
  OllamaLLMAuthToken: {
    envKey: "OLLAMA_AUTH_TOKEN",
    secret: true,
    checks: [],
  },

  // Mistral AI API Settings
  MistralApiKey: {
    envKey: "MISTRAL_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  MistralModelPref: {
    envKey: "MISTRAL_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // KoboldCPP Settings
  KoboldCPPBasePath: {
    envKey: "KOBOLD_CPP_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, isValidURL],
  },
  KoboldCPPModelPref: {
    envKey: "KOBOLD_CPP_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  KoboldCPPTokenLimit: {
    envKey: "KOBOLD_CPP_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },
  KoboldCPPMaxTokens: {
    envKey: "KOBOLD_CPP_MAX_TOKENS",
    secret: true,
    checks: [nonZero],
  },

  // Text Generation Web UI Settings
  TextGenWebUIBasePath: {
    envKey: "TEXT_GEN_WEB_UI_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  TextGenWebUITokenLimit: {
    envKey: "TEXT_GEN_WEB_UI_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },
  TextGenWebUIAPIKey: {
    envKey: "TEXT_GEN_WEB_UI_API_KEY",
    secret: true,
    checks: [],
  },

  // LiteLLM Settings
  LiteLLMModelPref: {
    envKey: "LITE_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  LiteLLMTokenLimit: {
    envKey: "LITE_LLM_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },
  LiteLLMBasePath: {
    envKey: "LITE_LLM_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  LiteLLMApiKey: {
    envKey: "LITE_LLM_API_KEY",
    secret: true,
    checks: [],
  },

  // Generic OpenAI InferenceSettings
  GenericOpenAiBasePath: {
    envKey: "GENERIC_OPEN_AI_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  GenericOpenAiModelPref: {
    envKey: "GENERIC_OPEN_AI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  GenericOpenAiTokenLimit: {
    envKey: "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },
  GenericOpenAiKey: {
    envKey: "GENERIC_OPEN_AI_API_KEY",
    secret: true,
    checks: [],
  },
  GenericOpenAiMaxTokens: {
    envKey: "GENERIC_OPEN_AI_MAX_TOKENS",
    secret: true,
    checks: [nonZero],
  },

  // AWS Bedrock LLM Settings
  AwsBedrockLLMApiKey: {
    envKey: "AWS_BEDROCK_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  AwsBedrockLLMRegion: {
    envKey: "AWS_BEDROCK_LLM_REGION",
    secret: false,
    checks: [isNotEmpty],
  },
  AwsBedrockLLMModel: {
    envKey: "AWS_BEDROCK_LLM_MODEL_PREFERENCE",
    secret: false,
    checks: [isNotEmpty],
  },
  AwsBedrockLLMTokenLimit: {
    envKey: "AWS_BEDROCK_LLM_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },
  AwsBedrockLLMMaxTokens: {
    envKey: "AWS_BEDROCK_LLM_MAX_TOKENS",
    secret: true,
    checks: [],
  },

  EmbeddingEngine: {
    envKey: "EMBEDDING_ENGINE",
    secret: false,
    checks: [supportedEmbeddingModel],
    postUpdate: [handleVectorStoreReset],
  },
  EmbeddingBasePath: {
    envKey: "EMBEDDING_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validDockerizedUrl],
  },
  EmbeddingModelPref: {
    envKey: "EMBEDDING_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
    postUpdate: [handleVectorStoreReset, downloadEmbeddingModelIfRequired],
  },
  EmbeddingModelMaxChunkLength: {
    envKey: "EMBEDDING_MODEL_MAX_CHUNK_LENGTH",
    secret: false,
    checks: [nonZero],
  },
  EmbeddingOutputDimensions: {
    envKey: "EMBEDDING_OUTPUT_DIMENSIONS",
    secret: false,
    checks: [],
  },
  OllamaEmbeddingBatchSize: {
    envKey: "OLLAMA_EMBEDDING_BATCH_SIZE",
    secret: false,
    checks: [nonZero],
  },

  // Gemini Embedding Settings
  GeminiEmbeddingApiKey: {
    envKey: "GEMINI_EMBEDDING_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },

  // Generic OpenAI Embedding Settings
  GenericOpenAiEmbeddingApiKey: {
    envKey: "GENERIC_OPEN_AI_EMBEDDING_API_KEY",
    secret: true,
    checks: [],
  },
  GenericOpenAiEmbeddingMaxConcurrentChunks: {
    envKey: "GENERIC_OPEN_AI_EMBEDDING_MAX_CONCURRENT_CHUNKS",
    secret: false,
    checks: [nonZero],
  },
  GenericOpenAiEmbeddingPassagePrefix: {
    envKey: "GENERIC_OPEN_AI_EMBEDDING_PASSAGE_PREFIX",
    secret: false,
    checks: [],
  },
  GenericOpenAiEmbeddingQueryPrefix: {
    envKey: "GENERIC_OPEN_AI_EMBEDDING_QUERY_PREFIX",
    secret: false,
    checks: [],
  },

  // Image Generation Settings
  ImageGenerationProvider: {
    envKey: "IMAGE_GEN_PROVIDER",
    secret: false,
    checks: [isNotEmpty, supportedImageGenerationProvider],
  },
  ImageGenerationModelPref: {
    envKey: "IMAGE_GEN_MODEL_PREF",
    secret: false,
    checks: [],
  },
  ImageGenerationDimensions: {
    envKey: "IMAGE_GEN_SIZE_PREF",
    secret: false,
    checks: [],
  },
  ImageGenerationOpenAiKey: {
    envKey: "IMAGE_GEN_OPENAI_KEY",
    secret: true,
    checks: [isNotEmpty, validOpenAIKey],
  },
  ImageGenerationOpenRouterApiKey: {
    envKey: "IMAGE_GEN_OPENROUTER_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  ImageGenerationOllamaBasePath: {
    envKey: "IMAGE_GEN_OLLAMA_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validOllamaLLMBasePath, validDockerizedUrl],
  },
  ImageGenerationOllamaAuthToken: {
    envKey: "IMAGE_GEN_OLLAMA_AUTH_TOKEN",
    secret: true,
    checks: [],
  },
  ImageGenerationLemonadeBasePath: {
    envKey: "IMAGE_GEN_LEMONADE_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  ImageGenerationLemonadeApiKey: {
    envKey: "IMAGE_GEN_LEMONADE_API_KEY",
    secret: true,
    checks: [],
  },
  ImageGenerationLocalAiBasePath: {
    envKey: "IMAGE_GEN_LOCALAI_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, validLLMExternalBasePath, validDockerizedUrl],
  },
  ImageGenerationLocalAiApiKey: {
    envKey: "IMAGE_GEN_LOCALAI_API_KEY",
    secret: true,
    checks: [],
  },

  // Vector Database Selection Settings
  VectorDB: {
    envKey: "VECTOR_DB",
    secret: false,
    checks: [isNotEmpty, supportedVectorDB],
    postUpdate: [handleVectorStoreReset],
  },

  // Chroma Options
  ChromaEndpoint: {
    envKey: "CHROMA_ENDPOINT",
    secret: "url",
    checks: [isValidURL, validChromaURL, validDockerizedUrl],
  },
  ChromaApiHeader: {
    envKey: "CHROMA_API_HEADER",
    secret: false,
    checks: [],
  },
  ChromaApiKey: {
    envKey: "CHROMA_API_KEY",
    secret: true,
    checks: [],
  },

  // ChromaCloud Options
  ChromaCloudApiKey: {
    envKey: "CHROMACLOUD_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  ChromaCloudTenant: {
    envKey: "CHROMACLOUD_TENANT",
    secret: false,
    checks: [isNotEmpty],
  },
  ChromaCloudDatabase: {
    envKey: "CHROMACLOUD_DATABASE",
    secret: false,
    checks: [isNotEmpty],
  },

  // Weaviate Options
  WeaviateEndpoint: {
    envKey: "WEAVIATE_ENDPOINT",
    secret: "url",
    checks: [isValidURL, validDockerizedUrl],
  },
  WeaviateApiKey: {
    envKey: "WEAVIATE_API_KEY",
    secret: true,
    checks: [],
  },

  // QDrant Options
  QdrantEndpoint: {
    envKey: "QDRANT_ENDPOINT",
    secret: "url",
    checks: [isValidURL, validDockerizedUrl],
  },
  QdrantApiKey: {
    envKey: "QDRANT_API_KEY",
    secret: true,
    checks: [],
  },
  PineConeKey: {
    envKey: "PINECONE_API_KEY",
    secret: true,
    checks: [],
  },
  PineConeIndex: {
    envKey: "PINECONE_INDEX",
    secret: false,
    checks: [],
  },

  // Milvus Options
  MilvusAddress: {
    envKey: "MILVUS_ADDRESS",
    secret: false,
    checks: [isValidURL, validDockerizedUrl],
  },
  MilvusUsername: {
    envKey: "MILVUS_USERNAME",
    secret: false,
    checks: [isNotEmpty],
  },
  MilvusPassword: {
    envKey: "MILVUS_PASSWORD",
    secret: true,
    checks: [isNotEmpty],
  },

  // Zilliz Cloud Options
  ZillizEndpoint: {
    envKey: "ZILLIZ_ENDPOINT",
    secret: "url",
    checks: [isValidURL],
  },
  ZillizApiToken: {
    envKey: "ZILLIZ_API_TOKEN",
    secret: true,
    checks: [isNotEmpty],
  },

  // Astra DB Options
  AstraDBApplicationToken: {
    envKey: "ASTRA_DB_APPLICATION_TOKEN",
    secret: true,
    checks: [isNotEmpty],
  },
  AstraDBEndpoint: {
    envKey: "ASTRA_DB_ENDPOINT",
    secret: "url",
    checks: [isNotEmpty],
  },

  /*
  PGVector Options
  - Does very simple validations - we should expand this in the future
  - to ensure the connection string is valid and the table name is valid
  - via direct query
  */
  PGVectorConnectionString: {
    envKey: "PGVECTOR_CONNECTION_STRING",
    secret: true,
    checks: [isNotEmpty, looksLikePostgresConnectionString],
    preUpdate: [validatePGVectorConnectionString],
  },
  PGVectorTableName: {
    envKey: "PGVECTOR_TABLE_NAME",
    secret: false,
    checks: [isNotEmpty],
    preUpdate: [validatePGVectorTableName],
  },

  // Together Ai Options
  TogetherAiApiKey: {
    envKey: "TOGETHER_AI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  TogetherAiModelPref: {
    envKey: "TOGETHER_AI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Fireworks AI Options
  FireworksAiLLMApiKey: {
    envKey: "FIREWORKS_AI_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  FireworksAiLLMModelPref: {
    envKey: "FIREWORKS_AI_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Perplexity Options
  PerplexityApiKey: {
    envKey: "PERPLEXITY_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  PerplexityModelPref: {
    envKey: "PERPLEXITY_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // OpenRouter Options
  OpenRouterApiKey: {
    envKey: "OPENROUTER_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  OpenRouterModelPref: {
    envKey: "OPENROUTER_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  OpenRouterTimeout: {
    envKey: "OPENROUTER_TIMEOUT_MS",
    secret: false,
    checks: [],
  },

  // Novita Options
  NovitaLLMApiKey: {
    envKey: "NOVITA_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  NovitaLLMModelPref: {
    envKey: "NOVITA_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  NovitaLLMTimeout: {
    envKey: "NOVITA_LLM_TIMEOUT_MS",
    secret: false,
    checks: [],
  },

  // Groq Options
  GroqApiKey: {
    envKey: "GROQ_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  GroqModelPref: {
    envKey: "GROQ_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Cohere Options
  CohereApiKey: {
    envKey: "COHERE_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  CohereModelPref: {
    envKey: "COHERE_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // VoyageAi Options
  VoyageAiApiKey: {
    envKey: "VOYAGEAI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },

  // Whisper (transcription) providers
  WhisperProvider: {
    envKey: "WHISPER_PROVIDER",
    secret: false,
    checks: [isNotEmpty, supportedTranscriptionProvider],
    postUpdate: [],
  },
  WhisperModelPref: {
    envKey: "WHISPER_MODEL_PREF",
    secret: false,
    checks: [validLocalWhisper],
    postUpdate: [],
  },
  WhisperGenericOpenAiBaseUrl: {
    envKey: "WHISPER_GENERIC_OPEN_AI_BASE_URL",
    secret: "url",
    checks: [isValidURL],
    postUpdate: [],
  },
  WhisperGenericOpenAiApiKey: {
    envKey: "WHISPER_GENERIC_OPEN_AI_API_KEY",
    secret: true,
    checks: [],
    postUpdate: [],
  },
  WhisperGenericOpenAiModel: {
    envKey: "WHISPER_GENERIC_OPEN_AI_MODEL",
    secret: false,
    checks: [isNotEmpty],
    postUpdate: [],
  },

  // System Settings
  AuthToken: {
    envKey: "AUTH_TOKEN",
    secret: true,
    checks: [requiresForceMode, noRestrictedChars],
  },
  JWTSecret: {
    envKey: "JWT_SECRET",
    secret: true,
    checks: [requiresForceMode],
  },
  DisableTelemetry: {
    envKey: "DISABLE_TELEMETRY",
    secret: false,
    checks: [],
    preUpdate: [
      (_, __, nextValue) => {
        if (nextValue === "true") Telemetry.sendTelemetry("telemetry_disabled");
      },
    ],
  },

  // Agent Integration ENVs
  AgentSerpApiKey: {
    envKey: "AGENT_SERPAPI_API_KEY",
    secret: true,
    checks: [],
  },
  AgentSerpApiEngine: {
    envKey: "AGENT_SERPAPI_ENGINE",
    secret: false,
    checks: [],
  },
  AgentSearchApiKey: {
    envKey: "AGENT_SEARCHAPI_API_KEY",
    secret: true,
    checks: [],
  },
  AgentSearchApiEngine: {
    envKey: "AGENT_SEARCHAPI_ENGINE",
    secret: false,
    checks: [],
  },
  AgentSerperApiKey: {
    envKey: "AGENT_SERPER_DEV_KEY",
    secret: true,
    checks: [],
  },
  AgentBingSearchApiKey: {
    envKey: "AGENT_BING_SEARCH_API_KEY",
    secret: true,
    checks: [],
  },
  AgentBaiduSearchApiKey: {
    envKey: "AGENT_BAIDU_SEARCH_API_KEY",
    secret: true,
    checks: [],
  },
  AgentSerplyApiKey: {
    envKey: "AGENT_SERPLY_API_KEY",
    secret: true,
    checks: [],
  },
  AgentSearXNGApiUrl: {
    envKey: "AGENT_SEARXNG_API_URL",
    secret: "url",
    checks: [],
  },
  AgentTavilyApiKey: {
    envKey: "AGENT_TAVILY_API_KEY",
    secret: true,
    checks: [],
  },
  AgentExaApiKey: {
    envKey: "AGENT_EXA_API_KEY",
    secret: true,
    checks: [],
  },
  AgentPerplexityApiKey: {
    envKey: "AGENT_PERPLEXITY_API_KEY",
    secret: true,
    checks: [],
  },
  AgentBraveApiKey: {
    envKey: "AGENT_BRAVE_API_KEY",
    secret: true,
    checks: [],
  },
  AgentCrwApiKey: {
    envKey: "AGENT_CRW_API_KEY",
    secret: true,
    checks: [],
  },
  AgentCrwApiUrl: {
    envKey: "AGENT_CRW_API_URL",
    secret: "url",
    checks: [],
  },
  AgentYouApiKey: {
    envKey: "AGENT_YOU_API_KEY",
    secret: true,
    checks: [],
  },

  // TTS/STT Integration ENVS
  TextToSpeechProvider: {
    envKey: "TTS_PROVIDER",
    secret: false,
    checks: [supportedTTSProvider],
  },

  // TTS OpenAI
  TTSOpenAIKey: {
    envKey: "TTS_OPEN_AI_KEY",
    secret: true,
    checks: [validOpenAIKey],
  },
  TTSOpenAIVoiceModel: {
    envKey: "TTS_OPEN_AI_VOICE_MODEL",
    secret: false,
    checks: [],
  },

  // TTS ElevenLabs
  TTSElevenLabsKey: {
    envKey: "TTS_ELEVEN_LABS_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  TTSElevenLabsVoiceModel: {
    envKey: "TTS_ELEVEN_LABS_VOICE_MODEL",
    secret: false,
    checks: [],
  },

  // PiperTTS Local
  TTSPiperTTSVoiceModel: {
    envKey: "TTS_PIPER_VOICE_MODEL",
    secret: false,
    checks: [],
  },

  // OpenAI Generic TTS
  TTSOpenAICompatibleKey: {
    envKey: "TTS_OPEN_AI_COMPATIBLE_KEY",
    secret: true,
    checks: [],
  },
  TTSOpenAICompatibleModel: {
    envKey: "TTS_OPEN_AI_COMPATIBLE_MODEL",
    secret: false,
    checks: [],
  },
  TTSOpenAICompatibleVoiceModel: {
    envKey: "TTS_OPEN_AI_COMPATIBLE_VOICE_MODEL",
    secret: false,
    checks: [isNotEmpty],
  },
  TTSOpenAICompatibleEndpoint: {
    envKey: "TTS_OPEN_AI_COMPATIBLE_ENDPOINT",
    secret: "url",
    checks: [isValidURL],
  },

  // Kokoro TTS (self-hosted kokoro-fastapi)
  TTSKokoroEndpoint: {
    envKey: "TTS_KOKORO_ENDPOINT",
    secret: "url",
    checks: [isValidURL],
  },
  TTSKokoroKey: {
    envKey: "TTS_KOKORO_KEY",
    secret: true,
    checks: [],
  },
  TTSKokoroVoiceModel: {
    envKey: "TTS_KOKORO_VOICE_MODEL",
    secret: false,
    checks: [isNotEmpty],
  },

  // STT Selection
  SpeechToTextProvider: {
    envKey: "STT_PROVIDER",
    secret: false,
    checks: [supportedSTTProvider],
  },

  // STT OpenAI
  STTOpenAIModel: {
    envKey: "STT_OPEN_AI_MODEL",
    secret: false,
    checks: [],
  },

  // STT Lemonade
  STTLemonadeBasePath: {
    envKey: "STT_LEMONADE_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  STTLemonadeModelPref: {
    envKey: "STT_LEMONADE_MODEL_PREF",
    secret: false,
    checks: [],
  },

  // STT Deepgram
  STTDeepgramApiKey: {
    envKey: "STT_DEEPGRAM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  STTDeepgramModel: {
    envKey: "STT_DEEPGRAM_MODEL",
    secret: false,
    checks: [isNotEmpty],
  },

  // STT OpenAI Generic
  STTOpenAICompatibleKey: {
    envKey: "STT_OPEN_AI_COMPATIBLE_KEY",
    secret: true,
    checks: [],
  },
  STTOpenAICompatibleModel: {
    envKey: "STT_OPEN_AI_COMPATIBLE_MODEL",
    secret: false,
    checks: [],
  },
  STTOpenAICompatibleEndpoint: {
    envKey: "STT_OPEN_AI_COMPATIBLE_ENDPOINT",
    secret: "url",
    checks: [isValidURL],
  },

  // STT Groq
  STTGroqApiKey: {
    envKey: "STT_GROQ_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  STTGroqModel: {
    envKey: "STT_GROQ_MODEL",
    secret: false,
    checks: [isNotEmpty],
  },

  // DeepSeek Options
  DeepSeekApiKey: {
    envKey: "DEEPSEEK_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  DeepSeekModelPref: {
    envKey: "DEEPSEEK_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Minimax Options
  MinimaxApiKey: {
    envKey: "MINIMAX_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  MinimaxModelPref: {
    envKey: "MINIMAX_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Cerebras Options
  CerebrasApiKey: {
    envKey: "CEREBRAS_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  CerebrasModelPref: {
    envKey: "CEREBRAS_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Google Vertex AI Options
  VertexAiLLMApiKey: {
    envKey: "VERTEX_AI_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  VertexAiLLMProjectId: {
    envKey: "VERTEX_AI_LLM_PROJECT_ID",
    secret: false,
    checks: [isNotEmpty],
  },
  VertexAiLLMRegion: {
    envKey: "VERTEX_AI_LLM_REGION",
    secret: false,
    checks: [isNotEmpty],
  },
  VertexAiLLMModelPref: {
    envKey: "VERTEX_AI_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  VertexAiLLMTokenLimit: {
    envKey: "VERTEX_AI_LLM_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },

  // APIPie Options
  ApipieLLMApiKey: {
    envKey: "APIPIE_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  ApipieLLMModelPref: {
    envKey: "APIPIE_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // xAI Options
  XAIApiKey: {
    envKey: "XAI_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  XAIModelPref: {
    envKey: "XAI_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Nvidia NIM Options
  NvidiaNimLLMBasePath: {
    envKey: "NVIDIA_NIM_LLM_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
    postUpdate: [
      (_, __, nextValue) => {
        const { parseNvidiaNimBasePath } = require("../AiProviders/nvidiaNim");
        process.env.NVIDIA_NIM_LLM_BASE_PATH =
          parseNvidiaNimBasePath(nextValue);
      },
    ],
  },
  NvidiaNimLLMModelPref: {
    envKey: "NVIDIA_NIM_LLM_MODEL_PREF",
    secret: false,
    checks: [],
    postUpdate: [
      async (_, __, nextValue) => {
        const { NvidiaNimLLM } = require("../AiProviders/nvidiaNim");
        await NvidiaNimLLM.setModelTokenLimit(nextValue);
      },
    ],
  },

  // PPIO Options
  PPIOApiKey: {
    envKey: "PPIO_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  PPIOModelPref: {
    envKey: "PPIO_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Moonshot AI Options
  MoonshotAiApiKey: {
    envKey: "MOONSHOT_AI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  MoonshotAiModelPref: {
    envKey: "MOONSHOT_AI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Foundry Options
  FoundryBasePath: {
    envKey: "FOUNDRY_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty],
  },
  FoundryModelPref: {
    envKey: "FOUNDRY_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
    postUpdate: [
      // On new model selection, re-cache the context windows
      async (_, prevValue, __) => {
        const { FoundryLLM } = require("../AiProviders/foundry");
        await FoundryLLM.unloadModelFromEngine(prevValue);
        await FoundryLLM.cacheContextWindows(true);
      },
    ],
  },
  FoundryModelTokenLimit: {
    envKey: "FOUNDRY_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },

  // CometAPI Options
  CometApiLLMApiKey: {
    envKey: "COMETAPI_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  CometApiLLMModelPref: {
    envKey: "COMETAPI_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  CometApiLLMTimeout: {
    envKey: "COMETAPI_LLM_TIMEOUT_MS",
    secret: false,
    checks: [],
  },

  // Z.AI Options
  ZAiApiKey: {
    envKey: "ZAI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  ZAiModelPref: {
    envKey: "ZAI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // GiteeAI Options
  GiteeAIApiKey: {
    envKey: "GITEE_AI_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  GiteeAIModelPref: {
    envKey: "GITEE_AI_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  GiteeAITokenLimit: {
    envKey: "GITEE_AI_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },

  // llmman Options
  LlmmanBasePath: {
    envKey: "LLMMAN_BASE_PATH",
    secret: "url",
    checks: [isNotEmpty, isValidURL, validDockerizedUrl],
  },
  LlmmanModelPref: {
    envKey: "LLMMAN_MODEL_PREF",
    secret: false,
    checks: [],
  },
  LlmmanTokenLimit: {
    envKey: "LLMMAN_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },
  LlmmanKeepAliveSeconds: {
    envKey: "LLMMAN_KEEP_ALIVE_TIMEOUT",
    secret: false,
    checks: [isInteger],
  },
  LlmmanAuthToken: {
    envKey: "LLMMAN_AUTH_TOKEN",
    secret: true,
    checks: [],
  },

  // Privatemode Options
  PrivateModeBasePath: {
    envKey: "PRIVATEMODE_LLM_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  PrivateModeModelPref: {
    envKey: "PRIVATEMODE_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // SambaNova Options
  SambaNovaLLMApiKey: {
    envKey: "SAMBANOVA_LLM_API_KEY",
    secret: true,
    checks: [isNotEmpty],
  },
  SambaNovaLLMModelPref: {
    envKey: "SAMBANOVA_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },

  // Lemonade Options
  LemonadeLLMBasePath: {
    envKey: "LEMONADE_LLM_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  LemonadeLLMApiKey: {
    envKey: "LEMONADE_LLM_API_KEY",
    secret: true,
    checks: [],
  },
  LemonadeLLMModelPref: {
    envKey: "LEMONADE_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  LemonadeLLMModelTokenLimit: {
    envKey: "LEMONADE_LLM_MODEL_TOKEN_LIMIT",
    secret: true,
    checks: [nonZero],
  },

  // OMLX Options
  OMLXLLMBasePath: {
    envKey: "OMLX_LLM_BASE_PATH",
    secret: "url",
    checks: [isValidURL],
  },
  OMLXLLMApiKey: {
    envKey: "OMLX_LLM_API_KEY",
    secret: true,
    checks: [],
  },
  OMLXLLMModelPref: {
    envKey: "OMLX_LLM_MODEL_PREF",
    secret: false,
    checks: [isNotEmpty],
  },
  OMLXLLMTokenLimit: {
    envKey: "OMLX_LLM_TOKEN_LIMIT",
    secret: true,
    checks: [],
  },

  // Agent Skill Settings
  AgentSkillMaxToolCalls: {
    envKey: "AGENT_MAX_TOOL_CALLS",
    secret: false,
    checks: [nonZero],
  },
  AgentSkillRerankerEnabled: {
    envKey: "AGENT_SKILL_RERANKER_ENABLED",
    secret: false,
    checks: [],
  },
  AgentSkillRerankerTopN: {
    envKey: "AGENT_SKILL_RERANKER_TOP_N",
    secret: false,
    checks: [nonZero],
  },
};

function isNotEmpty(input = "") {
  return !input || input.length === 0 ? "Value cannot be empty" : null;
}

function nonZero(input = "") {
  if (isNaN(Number(input))) return "Value must be a number";
  return Number(input) <= 0 ? "Value must be greater than zero" : null;
}

function isInteger(input = "") {
  if (isNaN(Number(input))) return "Value must be a number";
  return Number(input);
}

function isValidURL(input = "") {
  try {
    new URL(input);
    return null;
  } catch {
    return "URL is not a valid URL.";
  }
}

function validOpenAIKey(input = "") {
  return input.startsWith("sk-") ? null : "OpenAI Key must start with sk-";
}

function validAnthropicApiKey(input = "") {
  return input.startsWith("sk-ant-")
    ? null
    : "Anthropic Key must start with sk-ant-";
}

function validLLMExternalBasePath(input = "") {
  try {
    new URL(input);
    if (!input.includes("v1")) return "URL must include /v1";
    if (input.split("").slice(-1)?.[0] === "/")
      return "URL cannot end with a slash";
    return null;
  } catch {
    return "Not a valid URL";
  }
}

function validOllamaLLMBasePath(input = "") {
  try {
    new URL(input);
    if (input.split("").slice(-1)?.[0] === "/")
      return "URL cannot end with a slash";
    return null;
  } catch {
    return "Not a valid URL";
  }
}

function supportedTTSProvider(input = "") {
  const validSelection = [
    "native",
    "openai",
    "elevenlabs",
    "piper_local",
    "generic-openai",
    "kokoro",
  ].includes(input);
  return validSelection ? null : `${input} is not a valid TTS provider.`;
}

function supportedSTTProvider(input = "") {
  const validSelection = [
    "native",
    "openai",
    "lemonade",
    "deepgram",
    "groq",
    "generic-openai",
  ].includes(input);
  return validSelection ? null : `${input} is not a valid STT provider.`;
}

function validLocalWhisper(input = "") {
  const validSelection = [
    "Xenova/whisper-small",
    "Xenova/whisper-large",
  ].includes(input);
  return validSelection
    ? null
    : `${input} is not a valid Whisper model selection.`;
}

function supportedLLM(input = "") {
  const validSelection = [
    "openai",
    "azure",
    "anthropic",
    "gemini",
    "lmstudio",
    "localai",
    "ollama",
    "togetherai",
    "fireworksai",
    "mistral",
    "perplexity",
    "openrouter",
    "novita",
    "groq",
    "koboldcpp",
    "textgenwebui",
    "cohere",
    "litellm",
    "generic-openai",
    "bedrock",
    "deepseek",
    "apipie",
    "xai",
    "nvidia-nim",
    "ppio",
    "moonshotai",
    "cometapi",
    "foundry",
    "zai",
    "giteeai",
    "llmman",
    "privatemode",
    "sambanova",
    "lemonade",
    "minimax",
    "cerebras",
    "omlx",
    "anythingllm-router",
    "vertex",
  ].includes(input);
  return validSelection ? null : `${input} is not a valid LLM provider.`;
}

function supportedTranscriptionProvider(input = "") {
  const validSelection = ["openai", "generic-openai", "local"].includes(input);
  return validSelection
    ? null
    : `${input} is not a valid transcription model provider.`;
}

function validGeminiSafetySetting(input = "") {
  const validModes = [
    "BLOCK_NONE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_LOW_AND_ABOVE",
  ];
  return validModes.includes(input)
    ? null
    : `Invalid Safety setting. Must be one of ${validModes.join(", ")}.`;
}

function supportedEmbeddingModel(input = "") {
  const supported = [
    "openai",
    "azure",
    "gemini",
    "localai",
    "native",
    "ollama",
    "lmstudio",
    "cohere",
    "voyageai",
    "litellm",
    "generic-openai",
    "mistral",
    "openrouter",
    "lemonade",
  ];
  return supported.includes(input)
    ? null
    : `Invalid Embedding model type. Must be one of ${supported.join(", ")}.`;
}

function supportedVectorDB(input = "") {
  const supported = [
    "chroma",
    "chromacloud",
    "pinecone",
    "lancedb",
    "weaviate",
    "qdrant",
    "milvus",
    "zilliz",
    "astra",
    "pgvector",
  ];
  return supported.includes(input)
    ? null
    : `Invalid VectorDB type. Must be one of ${supported.join(", ")}.`;
}

function supportedImageGenerationProvider(input = "") {
  const supported = ["openai", "ollama", "lemonade", "openrouter", "localai"];
  return supported.includes(input)
    ? null
    : `Invalid image generation provider. Must be one of ${supported.join(", ")}.`;
}

function validChromaURL(input = "") {
  return input.slice(-1) === "/"
    ? `Chroma Instance URL should not end in a trailing slash.`
    : null;
}

function validOpenAiTokenLimit(input = "") {
  const tokenLimit = Number(input);
  if (isNaN(tokenLimit)) return "Token limit is not a number";
  return null;
}

function requiresForceMode(_, forceModeEnabled = false) {
  return forceModeEnabled === true ? null : "Cannot set this setting.";
}

async function validDockerizedUrl(input = "") {
  if (process.env.ANYTHING_LLM_RUNTIME !== "docker") return null;

  try {
    const { isPortInUse, getLocalHosts } = require("./portAvailabilityChecker");
    const localInterfaces = getLocalHosts();
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const port = parseInt(url.port, 10);

    // If not a loopback, skip this check.
    if (!localInterfaces.includes(hostname)) return null;
    if (isNaN(port)) return "Invalid URL: Port is not specified or invalid";

    const isPortAvailableFromDocker = await isPortInUse(port, hostname);
    if (isPortAvailableFromDocker)
      return "Port is not running a reachable service on loopback address from inside the ApproofWorkspace container. Please use host.docker.internal (for linux use 172.17.0.1), a real machine ip, or domain to connect to your service.";
  } catch (error) {
    console.error(error.message);
    return "An error occurred while validating the URL";
  }

  return null;
}

function noRestrictedChars(input = "") {
  const regExp = new RegExp(/^[a-zA-Z0-9_\-!@$%^&*();]+$/);
  return !regExp.test(input)
    ? `Your password has restricted characters in it. Allowed symbols are _,-,!,@,$,%,^,&,*,(,),;`
    : null;
}

async function handleVectorStoreReset(key, prevValue, nextValue) {
  if (prevValue === nextValue) return;
  if (key === "VectorDB") {
    console.log(
      `Vector configuration changed from ${prevValue} to ${nextValue} - resetting ${prevValue} namespaces`
    );
    return await resetAllVectorStores({ vectorDbKey: prevValue });
  }

  if (key === "EmbeddingEngine" || key === "EmbeddingModelPref") {
    console.log(
      `${key} changed from ${prevValue} to ${nextValue} - resetting ${process.env.VECTOR_DB} namespaces`
    );
    return await resetAllVectorStores({ vectorDbKey: process.env.VECTOR_DB });
  }
  return false;
}

/**
 * Downloads the embedding model in background if the user has selected a different model
 * - Only supported for the native embedder
 * - Must have the native embedder selected prior (otherwise will download on embed)
 */
async function downloadEmbeddingModelIfRequired(key, prevValue, nextValue) {
  if (prevValue === nextValue) return;
  if (key !== "EmbeddingModelPref" || process.env.EMBEDDING_ENGINE !== "native")
    return;

  const { NativeEmbedder } = require("../EmbeddingEngines/native");
  if (!NativeEmbedder.supportedModels[nextValue]) return; // if the model is not supported, don't download it
  new NativeEmbedder().embedderClient();
  return false;
}

/**
 * Validates the Postgres connection string for the PGVector options.
 * @param {string} input - The Postgres connection string to validate.
 * @returns {string} - An error message if the connection string is invalid, otherwise null.
 */
async function looksLikePostgresConnectionString(connectionString = null) {
  if (!connectionString || !connectionString.startsWith("postgresql://"))
    return "Invalid Postgres connection string. Must start with postgresql://";
  if (connectionString.includes(" "))
    return "Invalid Postgres connection string. Must not contain spaces.";
  return null;
}

/**
 * Validates the Postgres connection string for the PGVector options.
 * @param {string} key - The ENV key we are validating.
 * @param {string} prevValue - The previous value of the key.
 * @param {string} nextValue - The next value of the key.
 * @returns {string} - An error message if the connection string is invalid, otherwise null.
 */
async function validatePGVectorConnectionString(key, prevValue, nextValue) {
  const envKey = KEY_MAPPING[key].envKey;

  if (prevValue === nextValue) return; // If the value is the same as the previous value, don't validate it.
  if (!nextValue) return; // If the value is not set, don't validate it.
  if (nextValue === process.env[envKey]) return; // If the value is the same as the current connection string, don't validate it.

  const { PGVector } = require("../vectorDbProviders/pgvector");
  const { error, success } = await PGVector.validateConnection({
    connectionString: nextValue,
  });
  if (!success) return error;

  // Set the ENV variable for the PGVector connection string early so we can use it in the table check.
  process.env[envKey] = nextValue;
  return null;
}

/**
 * Validates the Postgres table name for the PGVector options.
 * - Table should not already exist in the database.
 * @param {string} key - The ENV key we are validating.
 * @param {string} prevValue - The previous value of the key.
 * @param {string} nextValue - The next value of the key.
 * @returns {string} - An error message if the table name is invalid, otherwise null.
 */
async function validatePGVectorTableName(key, prevValue, nextValue) {
  const envKey = KEY_MAPPING[key].envKey;

  if (prevValue === nextValue) return; // If the value is the same as the previous value, don't validate it.
  if (!nextValue) return; // If the value is not set, don't validate it.
  if (nextValue === process.env[envKey]) return; // If the value is the same as the current table name, don't validate it.
  if (!process.env.PGVECTOR_CONNECTION_STRING) return; // if connection string is not set, don't validate it since it will fail.

  const { PGVector } = require("../vectorDbProviders/pgvector");
  const { error, success } = await PGVector.validateConnection({
    connectionString: process.env.PGVECTOR_CONNECTION_STRING,
    tableName: nextValue,
  });
  if (!success) return error;

  return null;
}

// This will force update .env variables which for any which reason were not able to be parsed or
// read from an ENV file as this seems to be a complicating step for many so allowing people to write
// to the process will at least alleviate that issue. It does not perform comprehensive validity checks or sanity checks
// and is simply for debugging when the .env not found issue many come across.
async function updateENV(newENVs = {}, force = false, userId = null) {
  let error = "";
  const runAfterAll = [];
  const validKeys = Object.keys(KEY_MAPPING);
  const ENV_KEYS = Object.keys(newENVs).filter(
    (key) => validKeys.includes(key) && !/^\*+$/.test(newENVs[key]) // strip out answers where the value is all asterisks (masked placeholder)
  );
  const newValues = {};

  for (const key of ENV_KEYS) {
    const {
      envKey,
      checks,
      preUpdate = [], // Functions to run before updating a specific ENV variable
      postUpdate = [], // Functions to run after updating a specific ENV variable
      postSettled = [], // Functions to run after all ENV variables have been updated
    } = KEY_MAPPING[key];
    runAfterAll.push(...postSettled);
    const prevValue = process.env[envKey];
    const nextValue = newENVs[key];
    let errors = await executeValidationChecks(checks, nextValue, force);

    // If there are any errors from regular simple validation checks
    // exit early.
    if (errors.length > 0) {
      error += errors.join("\n");
      break;
    }

    // Accumulate errors from preUpdate functions
    errors = [];
    for (const preUpdateFunc of preUpdate) {
      const errorMsg = await preUpdateFunc(key, prevValue, nextValue);
      if (!!errorMsg && typeof errorMsg === "string") errors.push(errorMsg);
    }

    // If there are any errors from preUpdate functions
    // exit early.
    if (errors.length > 0) {
      error += errors.join("\n");
      break;
    }

    newValues[key] = nextValue;
    // process.env stays the read path for everything at runtime: hundreds of call
    // sites read these directly, and rewriting them is not this task. What changes is
    // where the value *persists* — a credential goes to the encrypted store, and
    // dumpENV no longer writes it to the file.
    process.env[envKey] = nextValue;
    if (KEY_MAPPING[key]?.secret === true) await persistCredential(envKey, nextValue);

    for (const postUpdateFunc of postUpdate)
      await postUpdateFunc(key, prevValue, nextValue);
  }

  for (const runAfterAllFunc of runAfterAll)
    await runAfterAllFunc(newValues, userId);

  await logChangesToEventLog(newValues, userId);
  if (process.env.NODE_ENV === "production") dumpENV();
  return {
    newValues: maskSecretValues(newValues),
    error: error?.length > 0 ? error : false,
  };
}

/**
 * Replaces the value of every credential-carrying setting so the response says which
 * settings changed without repeating what they are. The caller already knows the value
 * it just submitted; echoing it only creates copies in response bodies, proxy logs and
 * browser devtools.
 *
 * Two shapes, declared per entry by KEY_MAPPING's `secret` field:
 *  - `true`  — the whole value is the credential (an API key, a connection string).
 *  - `"url"` — an endpoint whose host and path are configuration an operator must see
 *              to confirm the setting took, but whose userinfo carries a password.
 *  - `false` — ordinary configuration, returned unchanged.
 *
 * The declaration replaces the name heuristic PR-4D(a) shipped: a credential whose env
 * name avoided all eight matched words was echoed in full, and nothing caught it. A
 * missing declaration is caught by the guard test rather than defaulting to visible.
 *
 * @param {Record<string, any>} values changed settings, keyed by KEY_MAPPING name
 * @returns {Record<string, any>} the same keys, credential values replaced
 */
function maskSecretValues(values = {}) {
  const masked = {};
  for (const [key, value] of Object.entries(values)) {
    masked[key] = maskOneValue(KEY_MAPPING[key]?.secret, value);
  }
  return masked;
}

const FULL_MASK = "**********";

function maskOneValue(declaration, value) {
  // An empty value is left alone: masking it would tell an operator a secret is
  // configured when nothing is.
  if (!value || typeof value !== "string") return value;
  // An undeclared key is treated as a secret. The guard test makes this unreachable
  // for KEY_MAPPING entries, but a caller can pass a name that is not in the table and
  // the safe reading of an unknown field is that it might hold anything.
  if (declaration === false) return value;
  if (declaration !== "url") return FULL_MASK;
  return stripUrlCredentials(value);
}

/**
 * Removes `user:pass@` from a URL, keeping everything an operator needs to recognise
 * the endpoint they configured.
 *
 * @param {string} value the submitted endpoint
 * @returns {string} the same URL without its userinfo, or a full mask when the value
 *   does not parse — an unrecognised shape in an endpoint field might contain anything.
 */
function stripUrlCredentials(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return FULL_MASK;
  }
  if (!url.username && !url.password) return value;
  url.username = "";
  url.password = "";
  // href re-serialises with a trailing slash on a bare host, which would read as a
  // changed value; keep the original's shape by rebuilding from the parts.
  return `${url.protocol}//${url.host}${url.pathname === "/" && !value.endsWith("/") ? "" : url.pathname}${url.search}${url.hash}`;
}

async function executeValidationChecks(checks, value, force) {
  const results = await Promise.all(
    checks.map((validator) => validator(value, force))
  );
  return results.filter((err) => typeof err === "string");
}

async function logChangesToEventLog(newValues = {}, userId = null) {
  const eventMapping = {
    LLMProvider: "update_llm_provider",
    EmbeddingEngine: "update_embedding_engine",
    VectorDB: "update_vector_db",
  };

  for (const [key, eventName] of Object.entries(eventMapping)) {
    if (!newValues.hasOwnProperty(key)) continue;
    await emitAuditEvent(eventName, {}, userId);
  }
  return;
}

/**
 * Persists one credential to the encrypted store instead of the .env file.
 *
 * A failure here is logged, not thrown: the value is already live in process.env and
 * the setting has been accepted, so throwing would 500 a request whose work is done.
 * The cost of the failure is that the credential does not survive a restart, which the
 * log says explicitly rather than leaving an operator to discover it later.
 *
 * @param {string} envKey
 * @param {string} value
 * @returns {Promise<void>}
 */
async function persistCredential(envKey, value) {
  const { CredentialStore } = require("../../models/credentialStore");
  // An empty value means "unset this credential", which is a delete, not a stored "".
  if (!value) {
    await CredentialStore.delete(envKey);
    return;
  }
  const { error } = await CredentialStore.set(envKey, value);
  if (error)
    console.error(
      `[credential-store] ${envKey} is live for this process but was not persisted; it will be lost on restart: ${error}`
    );
}

/**
 * Loads stored credentials into process.env at boot.
 *
 * dumpENV no longer writes credential values to the file, so without this a restart
 * comes up with every provider secret missing. Values already present in the
 * environment win: an operator who sets a variable directly, or a container that
 * injects one, is making a deliberate override that a database row should not silently
 * replace.
 *
 * @param {Object} store injectable for tests
 * @returns {Promise<{loaded:string[], skipped:string[]}>}
 */
async function loadStoredCredentials(store = null) {
  const { CredentialStore } = store
    ? { CredentialStore: store }
    : require("../../models/credentialStore");

  const loaded = [];
  const skipped = [];
  try {
    for (const envKey of await CredentialStore.keys()) {
      if (process.env[envKey]) {
        skipped.push(envKey);
        continue;
      }
      const value = await CredentialStore.get(envKey);
      // get() returns null for a row that fails its auth tag. Leaving the variable
      // unset is right: a provider that is not configured fails loudly at first use,
      // where a tampered value would fail silently or somewhere worse.
      if (value === null) continue;
      process.env[envKey] = value;
      loaded.push(envKey);
    }
  } catch (error) {
    // Boot must not depend on the store being reachable.
    console.error("[credential-store] could not load stored credentials:", error.message);
  }
  return { loaded, skipped };
}

/**
 * Keys that authenticate the INSTANCE rather than a provider. Never clearable.
 *
 * `AUTH_TOKEN` and `JWT_SECRET` are `secret: true` KEY_MAPPING entries, so without this
 * they would be clearable. The other three are not in KEY_MAPPING at all today and are
 * therefore already refused by the credential-key check below — they are listed anyway
 * because the harm if one were ever added is total (SIG_KEY/SIG_SALT decrypt the
 * credential store itself; API_KEY_PEPPER validates every API key), and a denylist that
 * only covers today's mapping is one PR away from being wrong.
 */
const INSTANCE_AUTH_KEYS = new Set([
  "AUTH_TOKEN",
  "JWT_SECRET",
  "SIG_KEY",
  "SIG_SALT",
  "API_KEY_PEPPER",
]);

/** Shape of an env key. Checked before the name is scanned or echoed anywhere. */
const ENV_KEY_PATTERN = /^[A-Z0-9_]{1,64}$/;

/**
 * Clears one stored credential: removes the encrypted row AND unsets the live value.
 *
 * #48: `persistCredential` has a delete branch for an empty value, but 49 of the 91
 * `secret: true` keys carry a validator that rejects "" before `updateENV` ever reaches
 * it — `force` does not help, because those validators do not read the flag. So for the
 * keys most worth revoking (`OpenAiKey`, `AnthropicApiKey`, ...) the branch is dead and
 * an operator has no way to take a credential back.
 *
 * Both halves are required. Deleting only the row leaves `process.env` holding the value
 * until the next restart, so the provider keeps working after the operator was told the
 * credential was cleared — a false belief in the unsafe direction. Unsetting only the
 * variable leaves the row, and `loadStoredCredentials()` puts it back on the next boot.
 *
 * Refuses any key that is not a `secret: true` entry in KEY_MAPPING: this must not become
 * a way to unset arbitrary process environment variables.
 *
 * @param {string} envKey
 * @param {Object} store injectable for tests
 * @returns {Promise<{cleared: boolean, error: string|null}>}
 */
async function clearStoredCredential(envKey, store = null) {
  // Techlead NIT-1: shape first, and the rejection does not echo what was sent. The
  // name comes off a URL path, so reflecting it back is caller-controlled text in a
  // response body — and the message below is the same for every malformed key, so it
  // says nothing about which names exist either.
  if (typeof envKey !== "string" || !ENV_KEY_PATTERN.test(envKey))
    return {
      cleared: false,
      error: "Invalid credential key.",
    };

  // QA-1 BLOCKER-1: `secret: true` is not the same question as "safe to unset".
  // `AUTH_TOKEN` and `JWT_SECRET` carry the flag because they must not be written to
  // the .env file in plaintext, but they are the instance's OWN authentication, not a
  // provider credential. Clearing AUTH_TOKEN takes `validatedRequest.js:29-36` down the
  // passthrough branch — `!process.env.AUTH_TOKEN` skips session auth entirely — so an
  // unauthenticated caller reaches `POST /system/update-env`. The row is deleted, so
  // boot does not put it back: the instance stays open. Clearing JWT_SECRET invalidates
  // every live session at once. Neither is a revocation an operator would recognise as
  // one, and the password flow is where they are meant to change.
  if (INSTANCE_AUTH_KEYS.has(envKey))
    return {
      cleared: false,
      error: `${envKey} is instance authentication, not a provider credential; use /system/update-password.`,
    };

  const isCredentialKey = Object.values(KEY_MAPPING).some(
    (values) => values.secret === true && values.envKey === envKey
  );
  if (!isCredentialKey)
    return {
      cleared: false,
      error: `${envKey} is not a stored credential.`,
    };

  const { CredentialStore } = store
    ? { CredentialStore: store }
    : require("../../models/credentialStore");

  // The row goes first. If the delete fails, the live value stays too — a half-cleared
  // credential that reappears on the next boot is worse than one that never left, and
  // the caller is told the clear did not happen.
  const removed = await CredentialStore.delete(envKey);
  if (!removed)
    return {
      cleared: false,
      error: `${envKey} could not be removed from the credential store.`,
    };

  delete process.env[envKey];
  return { cleared: true, error: null };
}

/**
 * @param {{envPath?: string}} options `envPath` overrides the default location. Tests
 *   pass a temp file: which settings reach the file is the property worth asserting,
 *   and asserting it should not mean writing over the repo's own .env.
 */
function dumpENV({ envPath: overridePath = null } = {}) {
  const fs = require("fs");
  const path = require("path");

  const frozenEnvs = {};
  const protectedKeys = [
    // P0-4D(c) part 3: credential-valued settings are excluded. Their values live in
    // the encrypted credential_store; writing them here would put the same secrets back
    // in plaintext on disk and in every backup of the storage volume, which is the
    // condition this task exists to end. `secret: "url"` entries stay: an endpoint is
    // configuration, and its inline credentials are stripped before it is stored.
    ...Object.values(KEY_MAPPING)
      .filter((values) => values.secret !== true)
      .map((values) => values.envKey),
    // Manually Add Keys here which are not already defined in KEY_MAPPING
    // and are either managed or manually set ENV key:values.
    "JWT_EXPIRY",

    "STORAGE_DIR",
    "SERVER_PORT",
    "COLLECTOR_PORT",
    // For persistent data encryption
    "SIG_KEY",
    "SIG_SALT",
    // Password Schema Keys if present.
    "PASSWORDMINCHAR",
    "PASSWORDMAXCHAR",
    "PASSWORDLOWERCASE",
    "PASSWORDUPPERCASE",
    "PASSWORDNUMERIC",
    "PASSWORDSYMBOL",
    "PASSWORDREQUIREMENTS",
    // HTTPS SETUP KEYS
    "ENABLE_HTTPS",
    "HTTPS_CERT_PATH",
    "HTTPS_KEY_PATH",
    // Other Configuration Keys
    "DISABLE_SWAGGER_DOCS",
    // Simple SSO
    "SIMPLE_SSO_ENABLED",
    "SIMPLE_SSO_NO_LOGIN",
    "SIMPLE_SSO_NO_LOGIN_REDIRECT",
    // Community Hub
    "COMMUNITY_HUB_BUNDLE_DOWNLOADS_ENABLED",

    // Nvidia NIM Keys that are automatically managed
    "NVIDIA_NIM_LLM_MODEL_TOKEN_LIMIT",

    // OCR Language Support
    "TARGET_OCR_LANG",

    // Collector API common ENV - allows bypassing URL validation checks
    "COLLECTOR_ALLOW_ANY_IP",

    // Allow disabling of streaming for generic openai
    "GENERIC_OPENAI_STREAMING_DISABLED",
    // Custom headers for Generic OpenAI
    "GENERIC_OPEN_AI_CUSTOM_HEADERS",

    // Specify Chromium args for collector
    "ANYTHINGLLM_CHROMIUM_ARGS",

    // Allow setting a custom response timeout for Ollama
    "OLLAMA_RESPONSE_TIMEOUT",

    // Allow disabling of MCP tool cooldown
    "MCP_NO_COOLDOWN",

    // Allow disabling of streaming for AWS Bedrock
    "AWS_BEDROCK_STREAMING_DISABLED",

    // Allow capabilities for specific providers.
    "PROVIDER_DISABLE_NATIVE_TOOL_CALLING",
    "PROVIDER_SUPPORTS_REASONING",
    "PROVIDER_SUPPORTS_IMAGE_GENERATION",
    "PROVIDER_SUPPORTS_VISION",
    "GENERIC_OPEN_AI_REPORT_USAGE",

    // Allow auto-approval of skills
    "AGENT_AUTO_APPROVED_SKILLS",

    // Allow setting a custom fetch timeouts for providers
    "ANYTHINGLLM_FETCH_TIMEOUT",
    "ANYTHINGLLM_MAX_RETRIES",

    // Deny-by-default for embed widgets that have no allowlist configured
    "EMBED_REQUIRE_ALLOWLIST",
  ];

  // Simple sanitization of each value to prevent ENV injection via newline or quote escaping.
  function sanitizeValue(value) {
    const offendingChars =
      /[\n\r\t\v\f\u0085\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"'`#]/;
    const firstOffendingCharIndex = value.search(offendingChars);
    if (firstOffendingCharIndex === -1) return value;

    return value.substring(0, firstOffendingCharIndex);
  }

  for (const key of protectedKeys) {
    const envValue = process.env?.[key] || null;
    if (!envValue) continue;
    frozenEnvs[key] = process.env?.[key] || null;
  }

  var envResult = `# Auto-dump ENV from system call on ${new Date().toTimeString()}\n`;
  envResult += Object.entries(frozenEnvs)
    .map(([key, value]) => `${key}='${sanitizeValue(value)}'`)
    .join("\n");

  const envPath = overridePath ?? path.join(__dirname, "../../.env");
  return writeEnvFileAtomic(envPath, envResult);
}

/**
 * Writes the .env file so that a crash cannot leave it truncated and no other
 * local account can read the provider secrets inside it: the content goes to a
 * temporary file in the same directory with mode 0600, is fsync'd, and is then
 * renamed over the destination. Rename within a directory is atomic, so a
 * reader sees either the whole old file or the whole new one.
 *
 * Refuses to write when the destination is a symlink, or when the existing file
 * belongs to another account. A symlink at this path means anyone who could
 * place it decides which file the process fills with secrets, and a file owned
 * by another account is either a misconfigured deployment or a planted file.
 * Both checks use lstat and run before anything is opened or chmod'd, so a
 * refused write leaves the link and its target exactly as they were.
 *
 * @param {string} envPath absolute path of the .env file to replace
 * @param {string} contents the full file body to write
 * @returns {boolean} true when written, false when refused
 */
function writeEnvFileAtomic(envPath, contents) {
  const crypto = require("crypto");
  const fs = require("fs");
  const path = require("path");

  // lstatSync, and no existsSync guard in front of it. stat resolves a symlink
  // and would report the target's owner and mode, so the checks below would
  // pass while the write landed somewhere else; existsSync follows the link
  // too, so a symlink aimed at a path that does not exist yet reports "absent"
  // and skips the guard entirely.
  let stats = null;
  try {
    stats = fs.lstatSync(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stats !== null) {
    if (stats.isSymbolicLink()) {
      console.error(
        `Refusing to write ${envPath}: the path is a symlink, and following it would write secrets to a file chosen by whoever created the link.`
      );
      return false;
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      console.error(
        `Refusing to write ${envPath}: file is owned by uid ${stats.uid}, not by the uid this process runs as.`
      );
      return false;
    }
    // No chmod of the destination here. The rename below replaces the inode, so
    // the new file carries the temp file's 0600 and the old mode cannot
    // survive. Touching the destination first would be a chmod through
    // whatever the path turns out to be, which is a primitive worth denying
    // rather than an improvement.
  }

  // The random suffix, not the pid, is what makes the name unique: two dumps in
  // the same process and millisecond would otherwise pick the same temp path
  // and one would fail the exclusive open.
  const tempPath = path.join(
    path.dirname(envPath),
    `.${path.basename(envPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(handle, contents, { encoding: "utf8" });
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tempPath, envPath);
  } catch (error) {
    if (handle !== null) fs.closeSync(handle);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return true;
}

module.exports = {
  KEY_MAPPING,
  loadStoredCredentials,
  clearStoredCredential,
  INSTANCE_AUTH_KEYS,
  ENV_KEY_PATTERN,
  dumpENV,
  updateENV,
  writeEnvFileAtomic,
  maskSecretValues,
};
