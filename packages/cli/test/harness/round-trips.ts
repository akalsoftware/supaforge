import net from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * A PostgreSQL proxy on 127.0.0.1 that counts the requests clients send which
 * wait for the server's answer: simple queries (`Q`) and extended-protocol
 * syncs (`S`). What crosses it is a run's round trips, which over a slow link
 * are its running time.
 */
export async function roundTripCounter(port: number): Promise<{ url: (u: string) => string; count: () => number; close: () => Promise<void> }> {
  let total = 0
  const sockets = new Set<net.Socket>()
  const server = net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1')
    sockets.add(client).add(upstream)
    let buf = Buffer.alloc(0)
    let started = false
    client.on('data', chunk => {
      upstream.write(chunk)
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (!started) {
          if (buf.length < 8 || buf.length < buf.readInt32BE(0)) break
          const code = buf.readInt32BE(4)
          buf = buf.subarray(buf.readInt32BE(0))
          // An SSLRequest or GSSENCRequest comes before the startup message.
          if (code !== 80877103 && code !== 80877104) started = true
          continue
        }
        if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) break
        if (buf[0] === 0x51 || buf[0] === 0x53) total++
        buf = buf.subarray(buf.readInt32BE(1) + 1)
      }
    })
    upstream.on('data', chunk => client.write(chunk))
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.end())
    upstream.on('close', () => client.end())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const own = (server.address() as AddressInfo).port
  return {
    url: u => u.replace(`:${port}/`, `:${own}/`),
    count: () => total,
    close: () => new Promise<void>(resolve => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
