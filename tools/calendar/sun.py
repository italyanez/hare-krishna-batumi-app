import math, datetime as dt
def sun_times(date, lat, lon, tz=4.0, zenith=90.833):
    """NOAA: возвращает (восход, закат) в минутах местного времени."""
    n = date.timetuple().tm_yday
    g = 2*math.pi/365*(n-1)
    eqt = 229.18*(0.000075+0.001868*math.cos(g)-0.032077*math.sin(g)-0.014615*math.cos(2*g)-0.040849*math.sin(2*g))
    dec = 0.006918-0.399912*math.cos(g)+0.070257*math.sin(g)-0.006758*math.cos(2*g)+0.000907*math.sin(2*g)-0.002697*math.cos(3*g)+0.00148*math.sin(3*g)
    la = math.radians(lat)
    ha = math.degrees(math.acos(math.cos(math.radians(zenith))/(math.cos(la)*math.cos(dec)) - math.tan(la)*math.tan(dec)))
    noon = 720 - 4*lon - eqt + tz*60
    return noon - 4*ha, noon + 4*ha
TBILISI = (41+43/60, 44+47/60)
BATUMI = (41.6168, 41.6367)
