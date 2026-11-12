"""配置管理 — LLM / 引擎 / 服务器"""

import os
from dataclasses import dataclass, field


@dataclass
class LLMConfig:
    api_key: str = os.getenv("DEEPSEEK_KEY", "")
    api_base: str = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
    model: str = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.3"))
    max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "4000"))


@dataclass
class EngineConfig:
    """JS 引擎 (ai-harbor) 配置"""
    base_url: str = os.getenv("ENGINE_BASE_URL", "http://ai-harbor:3000")
    timeout: float = float(os.getenv("ENGINE_TIMEOUT", "30"))


@dataclass
class ServerConfig:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8100"))
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")


llm_config = LLMConfig()
engine_config = EngineConfig()
server_config = ServerConfig()
