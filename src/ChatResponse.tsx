import { Streamdown } from 'streamdown'

interface ChatResponseProps {
  content: string
  isStreaming: boolean
}

export const ChatResponse: React.FC<ChatResponseProps> = ({ content, isStreaming }) => {
  return (
    <div className="chatbot-message-content">
      <Streamdown isAnimating={isStreaming}>{content}</Streamdown>
    </div>
  )
}
