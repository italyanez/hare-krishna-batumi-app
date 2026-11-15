import sys, json, re, datetime as dt
sys.path.insert(0, sys.argv[1])
from sun import sun_times, TBILISI, BATUMI
from ru import *
days = json.load(open(f'{sys.argv[1]}/days.json'))
FROM, TO = '2026-11-01', '2027-12-31'
fmt = lambda m: f'{int(m)//60:02d}:{int(round(m))%60:02d}' if False else f'{int(round(m))//60:02d}:{int(round(m))%60:02d}'
def to_min(s): h, m = s.split(':'); return int(h)*60+int(m)

def parana(day, text):
    m = re.match(r'Break fast (\d\d:\d\d) \(([^)]+)\)(?: - (\d\d:\d\d) \(([^)]+)\))? LT', text)
    if not m: return None
    d = dt.date.fromisoformat(day)
    sT, ssT = sun_times(d, *TBILISI); sB, ssB = sun_times(d, *BATUMI)
    shift = {'sunrise': sB - sT, '1/3 of daylight': (sB + (ssB - sB)/3) - (sT + (ssT - sT)/3)}
    labels = {'sunrise': 'восход', '1/3 of daylight': 'треть светового дня', 'end of tithi': 'конец двадаши', '1/4 of tithi': 'четверть двадаши'}
    a, ak, b, bk = m.group(1), m.group(2), m.group(3), m.group(4)
    A = to_min(a) + shift.get(ak, 0)
    out = {'date': day, 'from': fmt(A), 'fromNote': labels[ak]}
    if b:
        B = to_min(b) + shift.get(bk, 0)
        if ak not in shift: A = max(A, to_min(a))  # абсолютное время тити не сдвигаем
        out.update({'to': fmt(B), 'toNote': labels[bk]})
    return out

events, unknown = [], set()
for i, d in enumerate(days):
    if not (FROM <= d['date'] <= TO): continue
    last = None
    pending_note = None
    for e in d['events']:
        if e.startswith('Break fast') or 'Sun enters' in e or e.startswith(SKIP_PREFIX): continue
        if e in FASTS:
            if last: last['fast'] = (last.get('fast', '') + ('; ' if last.get('fast') else '') + FASTS[e])
            continue
        m = re.match(r'Fasting for (.+) Ekadasi$', e)
        item = None
        if m:
            name = m.group(1)
            nxt = days[i+1]
            p = next((parana(nxt['date'], x) for x in nxt['events'] if x.startswith('Break fast')), None)
            item = {'kind': 'ekadashi', 'title': f'{EKADASI[name]} экадаши', 'parana': p}
            if pending_note: item['note'] = pending_note; pending_note = None
        elif e in MAHADVADASI:
            # Маха-двадаши отмечается в тот же день, что и пост экадаши: делаем примечанием к нему
            md = MAHADVADASI[e] + (' — в этот раз пост соблюдают в день двадаши' if d['tithi'].startswith('Dvadasi') else '')
            pending_note = md
            continue
        elif e in MAJOR: item = {'kind': 'major', 'title': MAJOR[e]}
        else:
            key = next((k for k in FESTIVAL if e == k or e.startswith(k)), None)
            if key: item = {'kind': 'festival', 'title': FESTIVAL[key]}
            else:
                m = re.match(r'(.+) -- (Appearance|Disappearance)$', e)
                if m and m.group(1) in NAMES:
                    item = {'kind': 'acharya', 'title': f"{NAMES[m.group(1)]} — {'явление' if m.group(2) == 'Appearance' else 'уход'}"}
        if item is None:
            if not re.search(r'Masa, Gaurabda', e): unknown.add(e)
            continue
        item['date'] = d['date']; events.append(item); last = item

out = {
  'location': 'Батуми',
  'source': 'Официальный календарь ИСККОН (GCal 11, vaisnavacalendar.info) для Тбилиси; время выхода из поста пересчитано для Батуми по восходу солнца',
  'sourceUrl': 'https://www.vaisnavacalendar.info',
  'reminderBot': 'https://t.me/HappyEkadash_bot',
  'events': events,
}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
print('events', len(events), 'ekadashi', sum(e['kind']=='ekadashi' for e in events), 'major', sum(e['kind']=='major' for e in events))
print('unknown:', sorted(unknown))
for e in events[:14]: print(e)
