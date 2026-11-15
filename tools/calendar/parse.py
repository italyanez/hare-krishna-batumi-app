import re, json, sys, datetime as dt
MON={m:i+1 for i,m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}
days=[]; cur=None
for fn in ['tbilisi-2026.txt','tbilisi-2027.txt']:
    for line in open(fn, encoding='utf-8', errors='replace'):
        line=line.rstrip('\n')
        m=re.match(r'^\s?(\d{1,2}) (\w{3}) (\d{4}) \w\w\s+(.+?)\s{2,}([GK])\s(\S+)\s*(\*?)\s*$', line)
        if m:
            d=dt.date(int(m.group(3)),MON[m.group(2)],int(m.group(1)))
            cur={"date":d.isoformat(),"tithi":m.group(4).strip(),"paksa":m.group(5),"fast":bool(m.group(7)),"events":[]}
            days.append(cur); continue
        m=re.match(r'^\s{10,}(\S.*)$', line)
        if m and cur and not line.strip().startswith('DATE'): cur['events'].append(m.group(1).strip())
        m=re.match(r'^-+ (.+?) -+$', line)
        if m and cur: cur['events'].append(m.group(1).strip())
json.dump(days, open('days.json','w'), ensure_ascii=False, indent=1)
print(len(days), days[0]['date'], days[-1]['date'])
