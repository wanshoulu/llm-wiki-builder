# 知识问答 Agent

基于 OpenJiuwen DeepAgent 的知识图谱智能问答系统。

## 架构

```
前端 → FastAPI (Python Agent, 端口 8100) → ai-harbor (JS 引擎, 端口 3000)
                                           → DeepSeek LLM API
```

## 工具

| 工具 | 说明 |
|------|------|
| list_graphs | 列出可用图谱 |
| search_entities | 搜索图谱实体 |
| query_relations | 查询节点关系（按边类型/方向） |
| get_node | 获取节点详情 |
| expand_subgraph | BFS展开子图 |

## 启动

```bash
cd python
pip install -r requirements.txt
python -m app.main
# 或
uvicorn app.main:app --host 0.0.0.0 --port 8100
```
