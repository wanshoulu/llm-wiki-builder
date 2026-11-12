# SCHEMA — LLM Agent 知识库

## 领域
本知识库围绕 LLM Agent 主题，收录其定义、核心组件、架构模式、规划推理方法、工具与行动机制、记忆体系、多智能体协作方式、评估与安全风险及主流框架。范围覆盖从单 Agent 基础循环到多智能体编排，从内部推理到外部工具调用，从短期上下文到长期记忆与检索增强。

## 三层结构
- raw/ — 原始源材料（只读、不可变）
- entities/ — 实体页
- concepts/ — 概念页
- SCHEMA.md — 本契约；index.md — 单行摘要目录；log.md — 仅追加操作日志

## 页面规范
- 每页 frontmatter 必含：title / type(entity|concept) / tags / estimated / updated
- 每页至少 2 个 [[wikilink]] 交叉引用

## 知识地图
📁 entities | 实体页（具体对象：框架、基准测试等）
  📄 LangChain | 提供 Agent、工具、记忆、链式编排等组件的通用框架 | estimated:60L | tags:框架,开发工具
  📄 LlamaIndex | 侧重数据索引与检索增强，适合构建知识密集型 Agent 的框架 | estimated:50L | tags:框架,检索增强
  📄 AutoGen | 微软开源的多智能体对话框架，支持 Agent 间自动协作 | estimated:60L | tags:框架,多智能体
  📄 CrewAI | 面向角色化多智能体协作的框架，强调团队分工与流程编排 | estimated:50L | tags:框架,多智能体
  📄 AgentBench | 评估 Agent 任务完成率与效率的常用基准测试之一 | estimated:20L | tags:评估,基准测试
  📄 WebArena | 评估 Agent 任务完成率与效率的常用基准测试之一 | estimated:20L | tags:评估,基准测试
  📄 GAIA | 评估 Agent 任务完成率与效率的常用基准测试之一 | estimated:20L | tags:评估,基准测试

📁 concepts | 概念页（规则、主题、抽象知识）
  📄 LLM Agent 定义 | 以 LLM 为核心推理引擎，自主感知、规划、行动并迭代的智能系统定义 | estimated:40L | tags:基础,定义
  📄 LLM Agent 与单纯 LLM 的区别 | 对比 Agent 与单轮/多轮 LLM 在行动能力、状态持久化、目标分解上的差异 | estimated:40L | tags:基础,对比
  📄 Agent 核心组件 | 大脑、感知、行动、记忆四大组件及其职责 | estimated:50L | tags:基础,组件
  📄 单 Agent 循环 | perceive-plan-act-observe 经典循环，迭代直至任务完成或终止 | estimated:40L | tags:架构,循环
  📄 Plan-Execute 模式 | 先由规划器生成完整计划，再由执行器逐步执行的架构模式 | estimated:40L | tags:架构,规划
  📄 ReAct 范式 | Reasoning + Acting 交替的思考-行动-观察三元组范式 | estimated:60L | tags:架构,推理
  📄 任务分解 | 将复杂目标拆解为可执行子任务，包含自顶向下、递归与任务图方法 | estimated:50L | tags:规划,推理
  📄 Chain-of-Thought | 思维链提示，引导模型显式输出中间推理步骤以提升准确率 | estimated:40L | tags:推理,提示
  📄 Reflexion 自我反思 | 失败后对自身行为反思，生成改进建议存入记忆，实现自我改进 | estimated:50L | tags:推理,反思
  📄 工具调用 Function Calling | 模型按需选择并调用预定义函数，生成参数并回传结果继续推理 | estimated:50L | tags:工具,行动
  📄 代码执行 | Agent 生成并执行代码完成计算或数据处理，需沙箱隔离保障安全 | estimated:40L | tags:工具,安全
  📄 外部 API 集成 | 调用搜索、数据库、第三方服务等外部 API 扩展能力边界 | estimated:40L | tags:工具,集成
  📄 短期上下文 | 当前会话的对话历史与工作记忆，受上下文窗口长度限制 | estimated:30L | tags:记忆,上下文
  📄 长期记忆 | 跨会话持久化的知识存储，通常以向量数据库形式实现 | estimated:40L | tags:记忆,存储
  📄 向量检索与 RAG | 文档向量化后检索相关片段注入上下文，缓解知识陈旧与幻觉 | estimated:60L | tags:记忆,检索增强
  📄 角色分工 | 为不同 Agent 分配规划者、执行者、评审者等专门角色以提升能力 | estimated:40L | tags:多智能体,协作
  📄 通信协议 | Agent 间通过消息传递、共享黑板、结构化协议进行协作与信息交换 | estimated:40L | tags:多智能体,通信
  📄 编排框架 | 负责调度多 Agent 的执行顺序、任务分配与结果汇总 | estimated:50L | tags:多智能体,编排
  📄 Agent 评估基准 | 以 AgentBench、WebArena、GAIA 等基准评估任务完成率与效率 | estimated:30L | tags:评估,基准
  📄 幻觉与失控风险 | Agent 可能产生错误推理、调用危险工具、陷入无限循环或偏离目标 | estimated:40L | tags:评估,安全
  📄 对齐与护栏 | 通过权限限制、人工审核、沙箱隔离、输出过滤等手段约束行为 | estimated:50L | tags:评估,安全

## 交叉引用
[[LLM Agent 定义]] → [[Agent 核心组件]]: 核心组件是 LLM Agent 定义的组成部分
[[单 Agent 循环]] → [[ReAct 范式]]: ReAct 是单 Agent 循环的主流具体实现
[[ReAct 范式]] → [[工具调用 Function Calling]]: Action 步骤通常通过工具调用完成
[[短期上下文]] → [[长期记忆]]: 短期上下文受窗口限制，需长期记忆补充
[[长期记忆]] → [[向量检索与 RAG]]: 长期记忆常以向量数据库加 RAG 实现
[[向量检索与 RAG]] → [[LlamaIndex]]: LlamaIndex 侧重数据索引与检索增强
[[角色分工]] → [[编排框架]]: 角色分工需编排框架统一调度
[[通信协议]] → [[AutoGen]]: AutoGen 支持多智能体通过协议自动协作
[[对齐与护栏]] → [[代码执行]]: 代码执行需沙箱隔离等安全护栏
[[Agent 评估基准]] → [[AgentBench]]: AgentBench 是基准测试的一个代表