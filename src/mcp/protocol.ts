export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id?: JsonRpcId
  method?: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

type MessageHandler = (message: JsonRpcRequest) => void

export class StdioJsonRpc {
  private buffer = ''
  private framed = false
  private readonly onMessage: MessageHandler

  constructor(onMessage: MessageHandler) {
    this.onMessage = onMessage
  }

  start(): Promise<void> {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk
      this.drain()
    })
    return new Promise((resolve) => {
      process.stdin.on('end', resolve)
    })
  }

  send(payload: JsonRpcResponse): void {
    const json = JSON.stringify(payload)
    if (this.framed) {
      const bytes = Buffer.byteLength(json, 'utf8')
      process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`)
    } else {
      process.stdout.write(`${json}\n`)
    }
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      if (this.buffer.startsWith('Content-Length:')) {
        this.framed = true
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = this.buffer.slice(0, headerEnd)
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match?.[1]) {
          this.buffer = ''
          return
        }
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (this.buffer.length < bodyStart + length) return
        const body = this.buffer.slice(bodyStart, bodyStart + length)
        this.buffer = this.buffer.slice(bodyStart + length)
        this.emitJson(body)
        continue
      }

      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.emitJson(line)
    }
  }

  private emitJson(raw: string): void {
    try {
      this.onMessage(JSON.parse(raw) as JsonRpcRequest)
    } catch (err) {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error', data: String(err) },
      })
    }
  }
}
