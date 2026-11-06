/*
 * 最小 Marionette 客户端：够装临时扩展、导航、在页面里跑脚本。
 *
 * 协议要点（Firefox 159 实测）：
 *   握手   {"applicationType":"gecko","marionetteProtocol":3}
 *   命令   [0, id, "WebDriver:Navigate", {url}]  —— fx 并不认 {"name":…} 对象包
 *   响应   [1, id, error, result]
 *   分帧   "<字节长度>:<json>"，长度按 UTF-8 字节算
 */
import net from 'node:net';

export function connectMarionette(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let ready = false;
    const pending = new Map();
    let nextId = 1;
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);

    const pump = () => {
      for (;;) {
        const colon = buffer.indexOf(0x3a);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString('utf8'));
        if (!Number.isFinite(length)) return;
        if (buffer.length < colon + 1 + length) return;
        const json = buffer.subarray(colon + 1, colon + 1 + length).toString('utf8');
        buffer = buffer.subarray(colon + 1 + length);
        let packet;
        try {
          packet = JSON.parse(json);
        } catch (e) {
          continue;
        }
        if (!ready) {
          ready = true;
          resolve(client);
          continue;
        }
        /* 响应包：[1, id, error, result] */
        const [, id, error, result] = packet;
        const entry = pending.get(id);
        if (!entry) continue;
        pending.delete(id);
        if (error) entry.reject(Object.assign(new Error(error.message || 'marionette error'), { detail: error }));
        else entry.resolve(result);
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!ready) reject(new Error('Marionette 连接关闭'));
    });

    const deadline = Date.now() + timeout;
    const timer = setInterval(() => {
      if (ready) return clearInterval(timer);
      if (Date.now() > deadline) {
        clearInterval(timer);
        socket.destroy();
        reject(new Error('Marionette 握手超时'));
      }
    }, 200);

    const client = {
      cmd(name, parameters = {}) {
        const id = nextId++;
        const payload = JSON.stringify([0, id, name, parameters]);
        socket.write(`${Buffer.byteLength(payload, 'utf8')}:${payload}`);
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          setTimeout(() => {
            if (pending.delete(id)) reject(new Error('命令超时: ' + name));
          }, 30000);
        });
      },
      async simple(name, parameters) {
        const result = await client.cmd(name, parameters);
        return result && 'value' in result ? result.value : result;
      },
      async js(script) {
        return client.simple('WebDriver:ExecuteScript', { script, args: [] });
      },
      close() {
        try {
          socket.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    };
  });
}
