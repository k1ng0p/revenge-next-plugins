import { Design } from '@revenge-mod/discord/design'
import { useState } from 'react'

interface ReplyModalProps {
	name: string
	status: string
	onSend(text: string): void
	onCancel(): void
}

export default function ReplyModal({
	name,
	status,
	onSend,
	onCancel,
}: ReplyModalProps) {
	const [text, setText] = useState('')
	const { AlertModal, AlertActionButton, TextInput } = Design

	return (
		<AlertModal
			title={`Reply to ${name}'s status`}
			content={status}
			extraContent={
				<TextInput
					autoFocus
					placeholder="Your reply"
					value={text}
					onChange={setText}
				/>
			}
			actions={
				<>
					<AlertActionButton
						text="Send"
						variant="primary"
						disabled={!text.trim()}
						onPress={() => onSend(text.trim())}
					/>
					<AlertActionButton
						text="Cancel"
						variant="secondary"
						onPress={onCancel}
					/>
				</>
			}
		/>
	)
}
