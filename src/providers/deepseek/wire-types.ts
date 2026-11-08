/* Derived from DeepSeek Harness packages/llm/llm-deepseek.
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/** DeepSeek's supported subset of the Anthropic Messages request protocol. */

/** Text and inline or file-referenced images accepted in user messages and tool results. */
export type WireInput =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'file'; file_id: string } }

/** Content serialized into one Messages conversation turn. */
export type WireBlock = WireInput
  /** Activates or removes a declared tool by name in conversation order. */
  | { type: 'tool_addition' | 'tool_removal'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: WireInput[]; is_error?: boolean }

/** Conversation turn; capable routes retain later system updates in message history. */
export type WireMessage = {
  role: 'user' | 'assistant' | 'system'
  content: WireBlock[]
}

/** JSON body submitted to the resolved Messages endpoint. */
export type WireRequest = {
  model: string
  stream: true
  max_tokens: number
  messages: WireMessage[]
  system?: string
  thinking: { type: 'enabled' | 'disabled' }
  output_config?: { effort: 'low' | 'high' | 'max' }
  temperature?: number
  stop_sequences?: string[]
  tools?: {
    name: string
    description: string
    input_schema: Record<string, unknown>
    /** Delays tool availability until a tool_addition block activates it. */
    defer_loading?: true
  }[]
}
