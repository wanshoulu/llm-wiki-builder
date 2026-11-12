"""Agent 工厂 — 创建 OpenJiuwen DeepAgent"""

from pathlib import Path
from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig
from openjiuwen.core.single_agent import AgentCard
from openjiuwen.harness import Workspace, create_deep_agent

from .config import llm_config, engine_config
from .tools import (
    list_graphs, search_entities, query_relations,
    get_node, expand_subgraph, set_bridge,
)
from .engine_bridge import EngineBridge
from .prompt import build_system_prompt


def create_agent():
    """创建知识问答 DeepAgent 实例"""

    # 1. LLM 模型配置
    model = Model(
        ModelClientConfig(
            client_provider="openai",
            api_key=llm_config.api_key,
            api_base=llm_config.api_base,
            max_retries=0,
        ),
        ModelRequestConfig(
            model=llm_config.model,
            temperature=llm_config.temperature,
            max_tokens=llm_config.max_tokens,
        ),
    )

    # 2. Engine bridge
    bridge = EngineBridge(engine_config.base_url, engine_config.timeout)
    set_bridge(bridge)

    # 3. 工具列表
    all_tools = [list_graphs, search_entities, query_relations, get_node, expand_subgraph]

    # 4. AgentCard
    card = AgentCard(
        id="knowledge-qa-agent",
        name="知识问答助手",
        description="基于知识图谱的组织/人员/关系智能问答",
    )

    # 5. Workspace
    ws_root = Path(__file__).resolve().parent.parent / "workspace"
    ws_root.mkdir(parents=True, exist_ok=True)
    workspace = Workspace(root_path=str(ws_root), language="cn")

    # 6. System prompt
    system_prompt = build_system_prompt()

    # 7. 权限策略
    permissions = {
        "enabled": True,
        "schema": "tiered_policy",
        "tools": {t.card.name: "allow" for t in all_tools},
        "defaults": {"*": "deny"},
        "file_guard": {
            "enabled": True,
            "defaults": {"read": "deny", "write": "deny", "exec": "deny"},
            "paths": [],
        },
    }

    # 8. 创建 DeepAgent
    agent = create_deep_agent(
        model=model,
        card=card,
        workspace=workspace,
        system_prompt=system_prompt,
        tools=all_tools,
        skills=[],
        enable_task_loop=False,
        enable_task_planning=False,
        max_iterations=10,
        permissions=permissions,
        parallel_tool_calls=True,
        restrict_to_work_dir=True,
        enable_security_rail=False,
        language="cn",
    )

    return agent, bridge
