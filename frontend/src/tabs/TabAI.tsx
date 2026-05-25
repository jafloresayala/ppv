// src/tabs/TabAI.tsx
import { useRef, useEffect } from 'react'
import { Send, Bot, User, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { usePPV } from '../store/ppvStore'

// ── Lightweight Markdown renderer ───────────────────────────────────────────
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-slate-100 px-1 rounded text-xs font-mono">{part.slice(1, -1)}</code>
    return part
  })
}

function MarkdownMessage({ content }: { content: string }) {
  const lines = content.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      nodes.push(<p key={i} className="font-bold text-sm mt-2 mb-0.5 text-slate-800">{renderInline(line.slice(4))}</p>)
    } else if (line.startsWith('## ')) {
      nodes.push(<p key={i} className="font-bold text-sm mt-2 mb-0.5 text-slate-800">{renderInline(line.slice(3))}</p>)
    } else if (line.startsWith('# ')) {
      nodes.push(<p key={i} className="font-bold text-base mt-2 mb-0.5 text-slate-800">{renderInline(line.slice(2))}</p>)
    } else if (/^[-*]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].slice(2)); i++ }
      nodes.push(
        <ul key={`ul${i}`} className="list-disc pl-4 space-y-0.5 my-1">
          {items.map((it, j) => <li key={j} className="text-sm leading-relaxed">{renderInline(it)}</li>)}
        </ul>
      )
      continue
    } else if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s/, '')); i++ }
      nodes.push(
        <ol key={`ol${i}`} className="list-decimal pl-4 space-y-0.5 my-1">
          {items.map((it, j) => <li key={j} className="text-sm leading-relaxed">{renderInline(it)}</li>)}
        </ol>
      )
      continue
    } else if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={i} className="border-slate-200 my-2" />)
    } else if (line.trim() === '') {
      nodes.push(<div key={i} className="h-1.5" />)
    } else {
      nodes.push(<p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>)
    }
    i++
  }
  return <div className="flex flex-col gap-0.5">{nodes}</div>
}

export default function TabAI() {
  const { chatHistory, chatLoading, streamingMsg, sendMessage, clearChat, analytics } = usePPV()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatHistory, chatLoading])

  const handleSend = () => {
    const msg = input.trim()
    if (!msg || chatLoading) return
    setInput('')
    sendMessage(msg)
  }

  const SUGGESTIONS = [
    'What are the top cost drivers?',
    'Which vendors have the most unfavorable PPV?',
    'Are there any seasonal patterns?',
    'Which materials should I prioritize for negotiation?',
    'What is the overall trend of our PPV?',
  ]

  return (
    <div className="fade-in flex flex-col" style={{ height: '68vh' }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="text-brand" size={18} />
          <span className="font-semibold text-slate-700 text-sm">Kimi K2 — PPV Analysis Assistant</span>
          {!analytics && (
            <span className="badge badge-neutral text-xs">Query SAP data first for best results</span>
          )}
        </div>
        {chatHistory.length > 0 && (
          <button className="btn-ghost flex items-center gap-1 text-xs" onClick={clearChat}>
            <Trash2 size={12} /> Clear
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col gap-3">
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <Bot size={40} className="text-slate-300" />
            <p className="text-slate-400 text-sm max-w-sm">
              Ask me anything about your PPV data. I have full context of your analysis.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className="text-xs px-3 py-1.5 rounded-full border border-brand/30 text-brand hover:bg-brand/10 transition"
                  onClick={() => { setInput(s) }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatHistory.map((msg, i) => (
          <div key={i} className={`flex gap-2 items-start ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-brand' : 'bg-slate-200'}`}>
              {msg.role === 'user' ? <User size={14} className="text-white" /> : <Bot size={14} className="text-slate-600" />}
            </div>
            <div className={msg.role === 'user' ? 'bubble-user' : 'bubble-bot'}>
              {msg.role === 'assistant'
                ? <MarkdownMessage content={msg.content} />
                : <p className="text-sm leading-relaxed">{msg.content}</p>
              }
            </div>
          </div>
        ))}

        {/* Streaming in-progress bubble */}
        {streamingMsg !== null && (
          <div className="flex gap-2 items-start flex-row">
            <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 bg-slate-200">
              <Bot size={14} className="text-slate-600" />
            </div>
            <div className="bubble-bot">
              <MarkdownMessage content={streamingMsg} />
              <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-slate-400 rounded-sm align-middle animate-pulse" />
            </div>
          </div>
        )}

        {/* Waiting dots — only shown before first chunk arrives */}
        {chatLoading && streamingMsg === null && (
          <div className="flex gap-2 items-start">
            <div className="w-7 h-7 rounded-full flex items-center justify-center bg-slate-200 flex-shrink-0">
              <Bot size={14} className="text-slate-600" />
            </div>
            <div className="bubble-bot flex gap-1 items-center py-3 px-4">
              {[0, 0.15, 0.3].map(delay => (
                <span
                  key={delay}
                  className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
                  style={{ animationDelay: `${delay}s` }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="flex gap-3 mt-3">
        <input
          className="input-field flex-1"
          placeholder="Ask a question about your PPV data…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          disabled={chatLoading}
        />
        <button
          className="btn-primary flex items-center gap-2 px-5"
          onClick={handleSend}
          disabled={chatLoading || !input.trim()}
        >
          <Send size={15} />
          Send
        </button>
      </div>
    </div>
  )
}
