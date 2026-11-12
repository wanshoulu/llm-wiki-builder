"""知识问答 Agent 工具定义 — 5 个图谱查询工具"""

from typing import Any
from openjiuwen.core.foundation.tool import tool
from .engine_bridge import EngineBridge

# 全局 bridge 实例（由 agent_factory 注入）
_bridge: EngineBridge | None = None


def set_bridge(b: EngineBridge):
    global _bridge
    _bridge = b


@tool(
    name="list_graphs",
    description="列出所有可用的知识图谱。返回每个图谱的ID、名称、版本和描述。在用户未指定图谱或需要查看有哪些图谱时调用。",
    input_params={"type": "object", "properties": {}, "required": []},
    auto_extract=False,
)
async def list_graphs() -> dict[str, Any]:
    return await _bridge.call("/api/knowledge-qa/tools/list_graphs", method="GET")


@tool(
    name="search_entities",
    description="""在图谱中搜索实体节点。根据自然语言查询匹配组织、人员、职务等节点。
    返回匹配的节点列表，包含节点ID、标签、类型和匹配分数。
    这是查询的第一步：先找到相关实体，再用其ID查询关系。
    
    示例：
    - "西安软开一把手" → 搜索"西安软开"找到组织节点
    - "赵景川的职务" → 搜索"赵景川"找到人员节点
    - "算法工程部有几个小组" → 搜索"算法工程部"找到组织节点""",
    input_params={
        "type": "object",
        "properties": {
            "graphId": {"type": "string", "description": "图谱ID，如 'org/icbc-hr/org-graph-v3'"},
            "query": {"type": "string", "description": "搜索关键词或实体名称"},
            "topK": {"type": "integer", "description": "返回结果数上限，默认10", "default": 10},
        },
        "required": ["graphId", "query"],
    },
    auto_extract=False,
)
async def search_entities(graphId: str, query: str, topK: int = 10) -> dict[str, Any]:
    return await _bridge.call("/api/knowledge-qa/tools/search_entities", {
        "graphId": graphId, "query": query, "topK": topK,
    })


@tool(
    name="query_relations",
    description="""查询某个节点的关联关系（边）。按边类型和方向过滤。
    这是核心查询工具：找到实体后，用其ID查询具体关系。
    
    边类型说明：
    - SUP_STRU_E: 组织上下级关系（source=上级组织 → target=下级组织）
    - WORKING_STRU_E: 人员在职关系（source=人员 → target=组织）
    - SERVE_STRU_E: 人员任职关系（source=人员 → target=组织），含IF_PRESIDE_WORK属性
    - TEAMWORK_E: 班子分工（source=组织 → target=人员），含WORK_CONTENT属性
    - PERSON_REL_E: 人员汇报关系（source=下属 → target=上级）
    - PERSON_DUTY_E: 人员职务（source=人员 → target=职务节点）
    - ORG_INDEX_E: 组织索引
    
    方向说明：
    - 'outgoing': 从该节点出发的边（reverse=false）
    - 'incoming': 指向该节点的边（reverse=true）
    - 'both': 双向（默认）
    
    查询示例：
    - 找组织的负责人: nodeId=组织ID, edgeType='SERVE_STRU_E', direction='incoming'（人员→组织）
    - 找组织的班子成员: nodeId=组织ID, edgeType='TEAMWORK_E', direction='outgoing'（组织→人员）
    - 找下级部门: nodeId=组织ID, edgeType='SUP_STRU_E', direction='outgoing'（上级→下级）
    - 找向某人汇报的人: nodeId=人员ID, edgeType='PERSON_REL_E', direction='incoming'（下属→上级，上级是target）
    - 找某人的职务: nodeId=人员ID, edgeType='PERSON_DUTY_E', direction='outgoing'（人员→职务）
    - 不指定edgeType则返回所有边类型的关系""",
    input_params={
        "type": "object",
        "properties": {
            "graphId": {"type": "string", "description": "图谱ID"},
            "nodeId": {"type": "string", "description": "节点ID（来自search_entities的结果）"},
            "edgeType": {"type": "string", "description": "边类型（可选，不指定则返回所有）"},
            "direction": {"type": "string", "enum": ["outgoing", "incoming", "both"], "description": "方向过滤（默认both）"},
        },
        "required": ["graphId", "nodeId"],
    },
    auto_extract=False,
)
async def query_relations(graphId: str, nodeId: str, edgeType: str = "", direction: str = "both") -> dict[str, Any]:
    params = {"graphId": graphId, "nodeId": nodeId, "direction": direction}
    if edgeType:
        params["edgeType"] = edgeType
    return await _bridge.call("/api/knowledge-qa/tools/query_relations", params)


@tool(
    name="get_node",
    description="""获取节点详细信息，包括所有属性和邻接边类型概览。
    返回节点标签、类型、全部属性，以及该节点有哪些边类型（含各方向的计数）。
    用于了解节点全貌，判断应该查询哪些关系。""",
    input_params={
        "type": "object",
        "properties": {
            "graphId": {"type": "string", "description": "图谱ID"},
            "nodeId": {"type": "string", "description": "节点ID"},
        },
        "required": ["graphId", "nodeId"],
    },
    auto_extract=False,
)
async def get_node(graphId: str, nodeId: str) -> dict[str, Any]:
    return await _bridge.call("/api/knowledge-qa/tools/get_node", {
        "graphId": graphId, "nodeId": nodeId,
    })


@tool(
    name="expand_subgraph",
    description="""从指定节点出发，BFS展开子图。返回展开范围内的所有节点和边。
    用于"展开一层""看看周围有什么""组织架构"等需要展示关联结构场景。
    
    参数：
    - nodeIds: 起始节点ID列表
    - hops: 展开跳数（默认2，展开一层用1）""",
    input_params={
        "type": "object",
        "properties": {
            "graphId": {"type": "string", "description": "图谱ID"},
            "nodeIds": {"type": "array", "items": {"type": "string"}, "description": "起始节点ID列表"},
            "hops": {"type": "integer", "description": "展开跳数，默认2", "default": 2},
        },
        "required": ["graphId", "nodeIds"],
    },
    auto_extract=False,
)
async def expand_subgraph(graphId: str, nodeIds: list[str], hops: int = 2) -> dict[str, Any]:
    return await _bridge.call("/api/knowledge-qa/tools/expand_subgraph", {
        "graphId": graphId, "nodeIds": nodeIds, "hops": hops,
    })
