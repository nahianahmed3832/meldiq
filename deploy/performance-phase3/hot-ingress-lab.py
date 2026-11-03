"""Isolated nginx/HTTP keep-alive proof, unpublished ephemeral loopback ports, no live config."""
import http.client,http.server,importlib.util,json,os,pathlib,secrets,socket,subprocess,tempfile,threading,time
spec=importlib.util.spec_from_file_location('hot',pathlib.Path(__file__).with_name('hot-ingress.py'));hot=importlib.util.module_from_spec(spec);spec.loader.exec_module(hot)
ss=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  assert not self.headers.get('X-Meldiq-Release-Probe')
  value=self.server.tag.encode();self.send_response(200);self.send_header('Content-Length',str(len(value)));self.end_headers();self.wfile.write(value)
 def log_message(self,*args):pass
for tag in ['direct','gateway']:
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.tag=tag;ss.append(server);threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='meldiq-hot-',dir='/tmp') as t:
 d=pathlib.Path(t);d.chmod(0o755);flag=d/'enabled';key=secrets.token_hex(24)
 with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
 original=f'server {{ listen 127.0.0.1:{port}; location / {{\n        proxy_pass http://127.0.0.1:{ss[0].server_port};\n}} }}'.encode()
 conf=b'user www-data; error_log '+str(d/'error').encode()+b'; pid '+str(d/'pid').encode()+b'; daemon off; events {} http { access_log off; '+hot.render(original,key,flag,ss[0].server_port,ss[1].server_port)+b' }'
 (d/'nginx.conf').write_bytes(conf)
 proc=subprocess.Popen(['nginx','-p',t,'-c',str(d/'nginx.conf')],stderr=subprocess.PIPE)
 try:
  conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
  for _ in range(40):
   try:conn.connect();break
   except ConnectionRefusedError:time.sleep(.05)
  port0=conn.sock.getsockname();steps=[]
  for enabled in [False,True,False,True,False]:
   if enabled:flag.write_text('enabled')
   else:flag.unlink(missing_ok=True)
   count=0
   for _ in range(8):
    for header in ['',key,'wrong']:
     conn.request('GET','/probe',headers={'X-Meldiq-Release-Probe':header});r=conn.getresponse();body=r.read().decode()
     assert r.status==200 and body==('gateway' if enabled and header==key else 'direct') and conn.sock.getsockname()==port0
     count+=1
   steps.append({'enabled':enabled,'verified':count})
  print(json.dumps(dict(ok=True,requests=sum(s['verified'] for s in steps),sameClientTcpConnection=True,nginxReloadsDuringSwitches=0,steps=steps)))
 finally:
  proc.terminate();proc.wait(5)
for s in ss:s.shutdown();s.server_close()
