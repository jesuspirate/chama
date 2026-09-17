#!/usr/bin/env python3
"""Render the maintained Markdown overview. Requires reportlab (pip install reportlab)."""
from pathlib import Path
import re
from html import escape
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/technical-overview.md'
OUTPUT = ROOT / 'chama-technical-overview.pdf'
PAPER, INK, MUTED, LINE, ACCENT = map(HexColor, ['#f3f0e7','#202b25','#667067','#ced0c4','#94522d'])
W,H = 595.28,841.89
M=52
WIDTH=W-2*M
styles={
 'body':ParagraphStyle('body',fontName='Helvetica',fontSize=10.5,leading=16,textColor=INK,spaceAfter=12),
 'small':ParagraphStyle('small',fontName='Helvetica',fontSize=8,leading=12,textColor=MUTED),
 'heading':ParagraphStyle('heading',fontName='Helvetica-Bold',fontSize=12,leading=17,textColor=INK),
 'title':ParagraphStyle('title',fontName='Helvetica',fontSize=33,leading=37,textColor=INK),
}
def markup(s):
 s=escape(s)
 s=re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
 s=re.sub(r'`([^`]+)`', r'<font name="Courier" size="9">\1</font>', s)
 return s

def put(c,text,y,style='body'):
 p=Paragraph(markup(text),styles[style]); _,height=p.wrap(WIDTH,H)
 if y-height<75: raise ValueError(f'Page overflow: {text[:70]}')
 p.drawOn(c,M,y-height)
 return y-height

text=SOURCE.read_text()
parts=re.split(r'^## ',text,flags=re.M)
c=canvas.Canvas(str(OUTPUT),pagesize=(W,H),invariant=1)
c.setTitle('Chama - Advanced technical overview - 6.4 release line')
c.setAuthor('Chama')
c.setSubject('Current architecture, trust boundaries, recovery and feature gates')
for page,part in enumerate(parts):
 c.setFillColor(PAPER);c.rect(0,0,W,H,fill=1,stroke=0)
 c.setStrokeColor(LINE);c.line(M,62,W-M,62)
 c.setFillColor(MUTED);c.setFont('Helvetica',8)
 c.drawString(M,43,'CHAMA / ADVANCED TECHNICAL OVERVIEW')
 c.drawRightString(W-M,43,f'{page+1:02d} / {len(parts):02d}')
 if page==0:
  c.setFillColor(ACCENT);c.setFont('Helvetica-Bold',10);c.drawString(M,H-68,'PEOPLE. AGREEMENT. PROTOCOL.')
  c.setFillColor(INK);c.setFont('Helvetica-Bold',74);c.drawString(M,H-177,'chama')
  c.setFillColor(ACCENT);c.circle(M+247,H-167,5,stroke=0,fill=1)
  y=put(c,'Advanced technical overview',H-211,'title')-24
  blocks=part.strip().split('\n\n')[2:]
  for i,block in enumerate(blocks):
   y=put(c,block,y,'small' if i==1 else 'body')-18
  # A restrained three-person diagram, echoing the landing-page palette.
  cy=172
  positions=[M+45,W/2,W-M-45]
  c.setStrokeColor(LINE);c.line(positions[0],cy,positions[-1],cy)
  for x,label in zip(positions,['BUYER','SELLER','ARBITER']):
   c.setFillColor(PAPER);c.setStrokeColor(ACCENT);c.circle(x,cy,22,fill=1,stroke=1)
   c.setFillColor(INK);c.circle(x,cy+5,5,fill=1,stroke=0)
   c.roundRect(x-9,cy-10,18,10,5,fill=1,stroke=0)
   c.setFont('Helvetica',8);c.drawCentredString(x,cy-40,label)
 else:
  label,body=part.split('\n',1)
  c.setFillColor(ACCENT);c.setFont('Helvetica-Bold',9);c.drawString(M,H-60,label.upper())
  blocks=body.strip().split('\n\n')
  y=put(c,blocks[0],H-90,'title')-24
  for block in blocks[1:]:
   if block.startswith('### '):
    y=put(c,block[4:],y-5,'heading')-8
   elif block.startswith('Sources: '):
    y-=8
    # Each path links to the authoritative source instead of an obsolete PDF claim.
    paths=re.findall(r'`([^`]+)`',block)
    links='Source: '+ ' · '.join(f'<link href="https://github.com/jesuspirate/chama/blob/main/{escape(p)}" color="#94522d">{escape(p)}</link>' for p in paths)
    p=Paragraph(links,styles['small']);_,height=p.wrap(WIDTH,H)
    if y-height<75: raise ValueError(f'Source overflow on page {page+1}')
    p.drawOn(c,M,y-height);y-=height
   else:y=put(c,block.replace('\n',' '),y)-12
 c.showPage()
c.save()
print(OUTPUT)
