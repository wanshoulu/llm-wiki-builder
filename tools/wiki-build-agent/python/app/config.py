"""配置管理 — LLM / 存储 / 服务器（wiki-build-agent）。

LLM 连接参数与兄弟 agent（corporate-marketing-agent 等）保持同一套环境变量约定。
"""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class LLMConfig:
    api_key: str = os.getenv("DASHSCOPE_API_KEY", "")
    api_base: str = os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    model: str = os.getenv("LLM_MODEL", "qwen-plus")
    temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.3"))
    max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "8192"))
    # openjiuwen ModelClientConfig：真实超时与重试（替代旧流水线的 6 小时挂起）
    request_timeout: float = float(os.getenv("LLM_REQUEST_TIMEOUT", "300"))
    stream_first_chunk_timeout: float = float(os.getenv("LLM_FIRST_CHUNK_TIMEOUT", "120"))
    stream_idle_timeout: float = float(os.getenv("LLM_IDLE_TIMEOUT", "120"))
    max_retries: int = int(os.getenv("LLM_MAX_RETRIES", "2"))


@dataclass
class StorageConfig:
    wiki_root: Path = Path(os.getenv("WIKI_STORAGE_DIR", "/app/storage/wiki"))
    skills_root: Path = Path(os.getenv("WIKI_SKILLS_ROOT", "/app/workspace/skills"))


@dataclass
class ServerConfig:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8500"))
    cors_origins: str = os.getenv("CORS_ORIGINS", "*")
    # 单次构建流的整体上限（task_loop / 逐页生成的兜底护栏）
    stream_deadline: float = float(os.getenv("STREAM_DEADLINE_SECONDS", "3600"))


llm_config = LLMConfig()
storage_config = StorageConfig()
server_config = ServerConfig()
