#!/usr/bin/env python3
"""Validate enterprise official-document Wiki registries, pages and release controls."""

from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path
import yaml

DOMAINS={"document-type-and-format","language-expression","content-structure","policy-and-regulation","business-domain","history-and-cases"}
KNOWLEDGE_TYPES={"definition","mandatory-rule","prohibition","recommendation","judgment-method","template","case","term"}
LEVELS={"mandatory","prohibited","recommended","informative"}
STATUSES={"draft","pending_review","published","deprecated","superseded"}
EXECUTION_MODES={"deterministic","semantic","hybrid","human_only"}
RELATION_TYPES={"belongs_to","applies_to","requires","exception_to","conflicts_with","supersedes","related_to","illustrated_by","implements"}
SUPPORTED_FORMATS={"docx","pdf","ofd","xlsx","xls","csv","pptx","html","htm","md","txt","eml","msg","png","jpg","jpeg","tiff","zip"}
SOURCE_LEVELS={"national","industry","enterprise","case"}
OVERLAY_BEHAVIORS={"baseline","clarify","supplement","tighten","replace","illustrate"}
CONFLICT_STRATEGIES={"higher_authority","more_specific","later_explicit_supersession","pending_review"}
PLACEHOLDERS=re.compile(r"^(?:tbd|todo|待定|待确认|待补充|待命名.*|xxx+|\?+|无)$",re.I)
REQUIRED_SECTIONS=["规则摘要","适用与不适用","判断方法","依据"]

def item(path,message,kid=None): return {"file":str(path),"knowledge_id":kid,"message":message}
def missing(v): return v is None or v=="" or v==[] or v=={}
def placeholder(v):
    if isinstance(v,str): return bool(PLACEHOLDERS.match(v.strip()))
    if isinstance(v,list): return any(placeholder(x) for x in v)
    if isinstance(v,dict): return any(placeholder(x) for x in v.values())
    return False
def nested(d,*keys):
    for k in keys:
        if not isinstance(d,dict): return None
        d=d.get(k)
    return d
def load_yaml(path,errors,required=False):
    if not path.exists():
        if required: errors.append(item(path,"缺少治理注册表或发布清单"))
        return {}
    try:
        data=yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return data if isinstance(data,dict) else {}
    except Exception as exc:
        errors.append(item(path,f"YAML解析失败: {exc}")); return {}
def parse_page(path):
    raw=path.read_text(encoding="utf-8")
    if not raw.startswith("---\n"): return {},raw,[item(path,"缺少YAML frontmatter")]
    parts=raw.split("---",2)
    if len(parts)<3: return {},raw,[item(path,"YAML frontmatter未闭合")]
    try: meta=yaml.safe_load(parts[1]) or {}
    except Exception as exc: return {},parts[2],[item(path,f"YAML解析失败: {exc}")]
    return meta if isinstance(meta,dict) else {},parts[2],[]
def ids(rows,key): return {r.get(key) for r in rows if isinstance(r,dict) and r.get(key)}

def validate(root):
    errors=[]; warnings=[]
    gov=root/"governance"
    org_data=load_yaml(gov/"organization-registry.yaml",errors)
    doc_data=load_yaml(gov/"document-type-registry.yaml",errors)
    domain_data=load_yaml(gov/"business-domain-registry.yaml",errors)
    source_data=load_yaml(gov/"source-register.yaml",errors)
    release_data=load_yaml(gov/"release-manifest.yaml",errors)
    org_rows=org_data.get("organizations",[])
    orgs=ids(org_rows,"organization_id")
    doc_types=ids(doc_data.get("document_types",[]),"document_type_id")
    domains=ids(domain_data.get("business_domains",[]),"business_domain_id")
    source_rows={r.get("source_id"):r for r in source_data.get("sources",[]) if isinstance(r,dict) and r.get("source_id")}

    for row in org_rows:
        if not isinstance(row,dict): continue
        parent=row.get("parent_id")
        if parent and parent not in orgs:
            errors.append(item(gov/"organization-registry.yaml",f"机构{row.get('organization_id')}的父机构不存在: {parent}"))

    canonical={}
    canonical_dir=root/"sources"/"canonical-documents"
    if canonical_dir.exists():
        for path in canonical_dir.glob("*.yaml"):
            data=load_yaml(path,errors)
            sid=nested(data,"document","source_id")
            if not sid: errors.append(item(path,"Canonical Document缺少document.source_id")); continue
            units=ids(data.get("content_units",[]),"content_unit_id")
            canonical[sid]={"path":path,"units":units,"quality":nested(data,"quality","status")}
            if nested(data,"quality","status")!="passed": errors.append(item(path,f"Canonical Document解析质量未通过: {sid}"))

    for src,row in source_rows.items():
        fmt=str(row.get("file_format","")).lower()
        if fmt not in SUPPORTED_FORMATS: errors.append(item(gov/"source-register.yaml",f"来源{src}使用不支持的文件格式: {fmt}"))
        issuer=row.get("issuer_organization_id")
        if issuer and issuer not in orgs: errors.append(item(gov/"source-register.yaml",f"来源{src}的发布机构不在机构注册表: {issuer}"))
        if src not in canonical: errors.append(item(gov/"source-register.yaml",f"来源{src}缺少Canonical Document证据包"))
        elif set(row.get("content_unit_ids") or [])-canonical[src]["units"]:
            errors.append(item(gov/"source-register.yaml",f"来源{src}登记了Canonical Document中不存在的证据单元"))
        if row.get("source_level") not in SOURCE_LEVELS: errors.append(item(gov/"source-register.yaml",f"来源{src}的source_level不受支持"))
        if missing(row.get("authority_level")): errors.append(item(gov/"source-register.yaml",f"来源{src}缺少authority_level"))
        if row.get("overlay_behavior") not in OVERLAY_BEHAVIORS: errors.append(item(gov/"source-register.yaml",f"来源{src}的overlay_behavior不受支持"))
        if row.get("conflict_strategy") not in CONFLICT_STRATEGIES: errors.append(item(gov/"source-register.yaml",f"来源{src}的conflict_strategy不受支持"))
        if row.get("source_level")=="case" and row.get("overlay_behavior")!="illustrate": errors.append(item(gov/"source-register.yaml",f"案例来源{src}的overlay_behavior必须是illustrate"))

    rule_count=0
    rules_dir=root/"rules"
    if rules_dir.exists():
        for path in rules_dir.glob("*.yaml"):
            rule_count+=1; rule=load_yaml(path,errors); rid=rule.get("rule_id")
            for key in ["rule_id","source","source_level","authority_level","overlay_behavior","conflict_strategy","rule_type","normative_text","effect","scope","decision","execution_mode","status"]:
                if missing(rule.get(key)): errors.append(item(path,f"结构化规则{rid or ''}缺少字段: {key}"))
            rsrc=nested(rule,"source","source_id")
            if rsrc not in source_rows: errors.append(item(path,f"结构化规则{rid or ''}引用未知来源: {rsrc}"))
            rscope=rule.get("scope") or {}
            for oid in rscope.get("organization_ids") or []:
                if oid not in orgs: errors.append(item(path,f"结构化规则{rid or ''}引用未知机构: {oid}"))
            for did in rscope.get("document_type_ids") or []:
                if did not in doc_types: errors.append(item(path,f"结构化规则{rid or ''}引用未知文种: {did}"))
            for bid in rscope.get("business_domain_ids") or []:
                if bid not in domains: errors.append(item(path,f"结构化规则{rid or ''}引用未知业务领域: {bid}"))
            if rule.get("source_level") not in SOURCE_LEVELS: errors.append(item(path,f"结构化规则{rid or ''}的source_level不受支持"))
            if rule.get("overlay_behavior") not in OVERLAY_BEHAVIORS: errors.append(item(path,f"结构化规则{rid or ''}的overlay_behavior不受支持"))
            if rule.get("conflict_strategy") not in CONFLICT_STRATEGIES: errors.append(item(path,f"结构化规则{rid or ''}的conflict_strategy不受支持"))

    excluded_dirs={"raw","sources","rules","indexes","governance","reports","_reports","dist","_meta","validation"}
    excluded_files={"index.md","SCHEMA.md","log.md","README.md"}
    pages=[
        x for x in root.rglob("*.md")
        if x.name not in excluded_files
        and not any(part in excluded_dirs for part in x.relative_to(root).parts[:-1])
    ]
    parsed=[]; page_ids={}; published=[]
    for path in pages:
        meta,body,errs=parse_page(path); errors.extend(errs)
        if errs: continue
        kid=meta.get("knowledge_id")
        for key in ["knowledge_id","title","knowledge_domain","knowledge_type","document_type_ids","review_dimensions","applicable_scope","requirement_level","execution_mode","status","owner_role","source","source_level","authority_level","overlay_behavior","conflict_strategy"]:
            if missing(meta.get(key)): errors.append(item(path,f"缺少必填字段: {key}",kid))
        if "relationships" not in meta: errors.append(item(path,"缺少必填字段: relationships",kid))
        if meta.get("knowledge_domain") not in DOMAINS: errors.append(item(path,"knowledge_domain不在受控值中",kid))
        if meta.get("knowledge_type") not in KNOWLEDGE_TYPES: errors.append(item(path,"knowledge_type不在受控值中",kid))
        if meta.get("requirement_level") not in LEVELS: errors.append(item(path,"requirement_level不在受控值中",kid))
        if meta.get("execution_mode") not in EXECUTION_MODES: errors.append(item(path,"execution_mode不在受控值中",kid))
        if meta.get("status") not in STATUSES: errors.append(item(path,"status不在受控值中",kid))
        target=errors if meta.get("status")=="published" else warnings
        if placeholder(meta): target.append(item(path,"元数据中存在占位值",kid))

        scope=meta.get("applicable_scope") or {}
        org_ids=scope.get("organization_ids") or []
        domain_ids=scope.get("business_domain_ids") or []
        page_doc_types=meta.get("document_type_ids") or scope.get("document_type_ids") or []
        for oid in org_ids:
            if oid not in orgs: errors.append(item(path,f"机构注册表中不存在: {oid}",kid))
        for did in page_doc_types:
            if did not in doc_types: errors.append(item(path,f"文种注册表中不存在: {did}",kid))
        for bid in domain_ids:
            if bid not in domains: errors.append(item(path,f"业务领域注册表中不存在: {bid}",kid))
        for field in ["organization_ids","direction","business_domain_ids"]:
            if missing(scope.get(field)): errors.append(item(path,f"适用范围缺少applicable_scope.{field}",kid))

        src=meta.get("source") or {}; sid=src.get("source_id")
        if missing(sid): errors.append(item(path,"缺少source.source_id",kid))
        elif sid not in source_rows: errors.append(item(path,f"来源注册表中不存在: {sid}",kid))
        if meta.get("knowledge_type") in {"mandatory-rule","prohibition"} and missing(src.get("source_text")):
            errors.append(item(path,"强制或禁止规则缺少source.source_text原文依据",kid))
        evidence=src.get("evidence") or {}; unit=evidence.get("content_unit_id")
        if missing(unit): errors.append(item(path,"缺少证据单元source.evidence.content_unit_id",kid))
        elif sid in source_rows and unit not in (source_rows[sid].get("content_unit_ids") or []):
            errors.append(item(path,f"证据单元未登记在来源{sid}: {unit}",kid))
        elif sid in canonical and unit not in canonical[sid]["units"]:
            errors.append(item(path,f"证据单元不在Canonical Document中: {unit}",kid))
        source_level=meta.get("source_level")
        if source_level not in SOURCE_LEVELS: errors.append(item(path,"source_level不在受控值中",kid))
        if meta.get("overlay_behavior") not in OVERLAY_BEHAVIORS: errors.append(item(path,"overlay_behavior不在受控值中",kid))
        if meta.get("conflict_strategy") not in CONFLICT_STRATEGIES: errors.append(item(path,"conflict_strategy不在受控值中",kid))
        registered_level=(source_rows.get(sid) or {}).get("source_level")
        if registered_level and source_level!=registered_level: errors.append(item(path,"页面source_level与来源注册表不一致",kid))
        if source_level=="case" and meta.get("knowledge_type") not in {"case","definition","term"}: errors.append(item(path,"案例来源不能创设强制、禁止或建议规则",kid))

        rels=meta.get("relationships") or []
        if not isinstance(rels,list): errors.append(item(path,"relationships必须是列表",kid)); rels=[]
        for rel in rels:
            if not isinstance(rel,dict): errors.append(item(path,"关系必须是对象",kid)); continue
            if rel.get("type") not in RELATION_TYPES: errors.append(item(path,"关系类型缺失或不受支持",kid))
            if missing(rel.get("target_id")): errors.append(item(path,"关系缺少target_id",kid))

        if meta.get("knowledge_type") not in {"case","term","definition"}:
            for section in REQUIRED_SECTIONS:
                if not re.search(rf"^##\s+{re.escape(section)}\s*$",body,re.M): errors.append(item(path,f"正文缺少章节: {section}",kid))
        if not re.search(r"^#\s+\S+",body,re.M): errors.append(item(path,"正文缺少一级标题",kid))
        if kid:
            if kid in page_ids: errors.append(item(path,f"knowledge_id重复，首次出现于{page_ids[kid]}",kid))
            else: page_ids[kid]=path
        parsed.append((path,meta));
        if meta.get("status")=="published": published.append((path,meta))

    for path,meta in parsed:
        kid=meta.get("knowledge_id")
        for rel in meta.get("relationships") or []:
            if isinstance(rel,dict) and rel.get("target_id") not in page_ids: errors.append(item(path,f"关联知识不存在: {rel.get('target_id')}",kid))
        for field in ["supersedes","superseded_by"]:
            for target_id in meta.get(field) or []:
                if target_id not in page_ids: errors.append(item(path,f"关联知识不存在: {field} -> {target_id}",kid))

    release_rows=nested(release_data,"release","pages") or []
    release_map={r.get("knowledge_id"):r.get("approval_record_id") for r in release_rows if isinstance(r,dict)}
    for path,meta in published:
        kid=meta.get("knowledge_id"); approval=meta.get("approval") or {}; aid=approval.get("approval_record_id")
        for field in ["approval_record_id","reviewer_id","reviewer_role","reviewed_at"]:
            if missing(approval.get(field)) or placeholder(approval.get(field)): errors.append(item(path,f"已发布页面缺少有效approval.{field}",kid))
        if kid not in release_map: errors.append(item(path,"已发布页面不在外部发布清单中",kid))
        elif release_map.get(kid)!=aid: errors.append(item(path,"发布清单与页面审批记录不一致",kid))
        if missing(meta.get("effective_date")): errors.append(item(path,"已发布页面缺少effective_date",kid))

    return {"root":str(root),"page_count":len(parsed),"rule_count":rule_count,"registry_counts":{"organizations":len(orgs),"document_types":len(doc_types),"business_domains":len(domains),"sources":len(source_rows),"canonical_documents":len(canonical)},"errors":errors,"warnings":warnings,"status":"pass" if not errors else "fail"}

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("wiki_root",type=Path);ap.add_argument("--json",action="store_true");a=ap.parse_args()
    if not a.wiki_root.is_dir(): print(json.dumps({"errors":[{"message":"wiki_root不是目录"}]},ensure_ascii=False));return 2
    result=validate(a.wiki_root)
    if a.json: print(json.dumps(result,ensure_ascii=False,indent=2,default=str))
    else:
        print(f"Wiki pages: {result['page_count']}; Errors: {len(result['errors'])}; Warnings: {len(result['warnings'])}")
        for e in result["errors"]: print(f"ERROR {e['file']}: {e['message']}")
        for w in result["warnings"]: print(f"WARN  {w['file']}: {w['message']}")
    return 0 if result["status"]=="pass" else 1

if __name__=="__main__": sys.exit(main())
