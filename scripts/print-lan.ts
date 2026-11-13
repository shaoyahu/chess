/**
 * 打印本机局域网 IPv4 地址，方便其他设备访问。
 * 用法：npm run lan
 */
import os from 'node:os';

const nets = os.networkInterfaces();
const list: string[] = [];

for (const name of Object.keys(nets)) {
  for (const net of nets[name] ?? []) {
    // @types/node 新版把 family 固定为字符串；旧版是数字 4/6
    const family = String(net.family);
    if ((family === 'IPv4' || family === '4') && !net.internal) list.push(net.address);
  }
}

const port = process.env.PORT ?? '3000';

if (list.length === 0) {
  console.log('未找到局域网 IPv4 地址（可能未连接网络）。');
} else {
  console.log('\n局域网访问地址：');
  for (const ip of list) {
    console.log(`  http://${ip}:${port}`);
  }
  console.log('\n其他设备用浏览器打开上面的地址即可加入对局。\n');
}
