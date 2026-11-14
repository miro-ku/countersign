import sys,base64,os,collections
os.makedirs('shots',exist_ok=True); parts=collections.OrderedDict()
for line in sys.stdin:
    if line.startswith('B64 '):
        _,n,d=line.rstrip('\n').split(' ',2); parts.setdefault(n,[]).append(d)
    else: print(line,end='')
for n,ps in parts.items():
    open('shots/'+n+'.jpg','wb').write(base64.b64decode(''.join(ps))); print('saved shots/'+n+'.jpg')
