# -*- coding: utf-8 -*-
"""
公文审核 Agent 测试 PDF 生成器（reportlab + 嵌入 TTF 字体）

字体说明：使用 Windows 自带中文字体嵌入生成：
  - 正文/落款：仿宋（simfang.ttf）
  - 标题：黑体（simhei.ttf，近似公文标题字体）
  注意：不用 UnicodeCIDFont('STSong-Light')——CID 字体无 ToUnicode CMap，
  pdf-parse v2 提取不到正文文本，会导致审阅管道拿到空文档。

生成 3 篇 PDF 测试文档：
  22-standard-report.pdf  标准报告（无问题）
  23-faulty-notice.pdf    问题通知（口语化/半角标点/斜杠日期/方括号文号/缺结语）
  24-faulty-request.pdf   多头主送请示（P1）

用法: python tools/doc-review-agent/gen-test-pdfs.py
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

FONTS_DIR = 'C:/Windows/Fonts'
pdfmetrics.registerFont(TTFont('FangSong', os.path.join(FONTS_DIR, 'simfang.ttf')))
pdfmetrics.registerFont(TTFont('HeiTi', os.path.join(FONTS_DIR, 'simhei.ttf')))

TEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test-docs')

STYLES = {
    'title': ParagraphStyle('title', fontName='HeiTi', fontSize=22, leading=30,
                            alignment=TA_CENTER, spaceAfter=12),
    'docnum': ParagraphStyle('docnum', fontName='FangSong', fontSize=16, leading=24,
                             alignment=TA_CENTER, spaceAfter=12),
    'body': ParagraphStyle('body', fontName='FangSong', fontSize=16, leading=28,
                           alignment=TA_LEFT, firstLineIndent=32, spaceAfter=4),
    'flush': ParagraphStyle('flush', fontName='FangSong', fontSize=16, leading=28,
                            alignment=TA_LEFT, spaceAfter=4),
    'sign': ParagraphStyle('sign', fontName='FangSong', fontSize=16, leading=28,
                           alignment=TA_RIGHT, spaceAfter=4),
}


def build_pdf(filename, blocks):
    path = os.path.join(TEST_DIR, filename)
    doc = SimpleDocTemplate(path, pagesize=A4,
                            topMargin=37 * 2.835, bottomMargin=35 * 2.835,
                            leftMargin=28 * 2.835, rightMargin=26 * 2.835)
    story = []
    for style_name, text in blocks:
        if style_name == 'spacer':
            story.append(Spacer(1, text))
        else:
            story.append(Paragraph(text, STYLES[style_name]))
    doc.build(story)
    print('  [OK] Created:', filename)


def main():
    if not os.path.isdir(TEST_DIR):
        os.makedirs(TEST_DIR)

    # ── 22: 标准报告 ──
    build_pdf('22-standard-report.pdf', [
        ('title', '关于2026年第三季度工作情况的报告'),
        ('flush', '总行：'),
        ('body', '2026年第三季度，我部认真贯彻落实总行工作部署，扎实推进各项业务，现将有关情况报告如下。'),
        ('body', '一、主要工作完成情况'),
        ('body', '核心系统升级改造项目按计划推进，已完成总体架构设计。'),
        ('body', '二、存在问题'),
        ('body', '部分项目进度滞后，需加大推进力度。'),
        ('body', '三、下步打算'),
        ('body', '加快推进核心系统升级改造，确保按期完成年度目标。'),
        ('body', '特此报告'),
        ('sign', '科技部'),
        ('sign', '2026年10月8日'),
    ])

    # ── 23: 问题通知（口语化/半角标点/斜杠日期/方括号文号/缺结语） ──
    build_pdf('23-faulty-notice.pdf', [
        ('title', '关于搞经济工作的会议通知'),
        ('docnum', 'XX银办发[2026]5号'),
        ('flush', '各位领导:'),
        ('body', '为贯彻落实上头精神,我们觉得应该召开一个会议,大概讨论一下经济工作.这个会议搞的好的话,能够取得巨大成效.'),
        ('body', '一.会议时间'),
        ('body', '2026/11/15'),
        ('body', '二.会议地点'),
        ('body', '总行三楼会议室'),
        ('body', '请各位务必参加,缺席者后果自负'),
        ('sign', '办公室'),
        ('sign', '2026-11-8'),
    ])

    # ── 24: 多头主送请示 ──
    build_pdf('24-faulty-request.pdf', [
        ('title', '关于申请追加科技研发预算的请示'),
        ('flush', '总行、财政部：'),
        ('body', '根据我行2026年度科技研发项目进展情况，部分重点项目需追加预算。具体原因如下。'),
        ('body', '一、项目背景'),
        ('body', '核心系统升级改造项目于2026年3月启动，原预算2000万元。因技术架构调整，需追加预算500万元。'),
        ('body', '二、追加预算必要性'),
        ('body', '核心系统升级是2026年度重点工作，须按期完成。'),
        ('body', '妥否，请批示'),
        ('sign', '科技部'),
        ('sign', '2026年10月8日'),
    ])

    print('\nAll test PDFs created in:', TEST_DIR)


if __name__ == '__main__':
    main()
