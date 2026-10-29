import { Inject, Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { AiChatAssistantMode } from 'src/engine/core-modules/workspace/enums/ai-chat-assistant-mode.enum';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { AgentChatAssistantPolicyService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-assistant-policy.service';
import { AgentChatReplyPolicyService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-reply-policy.service';
import { readAgentChatAssistantReplyContext } from 'src/engine/metadata-modules/ai/ai-chat/utils/read-agent-chat-assistant-reply-context.util';
import { resolveAgentChatAssistantParticipation } from 'src/engine/metadata-modules/ai/ai-chat/utils/resolve-agent-chat-assistant-participation.util';
import { AgentMessageRole } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-message-role.enum';
import { type AgentHistoryRepository } from 'src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository';
import { getAgentHistoryRepositoryToken } from 'src/engine/metadata-modules/ai/ai-history/repositories/inject-agent-history-repository.decorator';
import { type AgentChatThreadWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity';
import { type AgentMessageWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-message.workspace-entity';

@Injectable()
export class AgentChatReplyExecutionPolicyService {
  @Inject(getAgentHistoryRepositoryToken('agentChatThread'))
  private readonly threadRepository: AgentHistoryRepository<AgentChatThreadWorkspaceEntity>;

  @Inject(getAgentHistoryRepositoryToken('agentMessage'))
  private readonly messageRepository: AgentHistoryRepository<AgentMessageWorkspaceEntity>;

  @Inject(AgentChatAssistantPolicyService)
  private readonly assistantPolicyService: AgentChatAssistantPolicyService;

  @Inject(AgentChatReplyPolicyService)
  private readonly replyPolicyService: AgentChatReplyPolicyService;

  async shouldExecute({
    threadId,
    workspace,
    workspaceMemberId,
    userWorkspaceId,
    messageId,
  }: {
    threadId: string;
    workspace: WorkspaceEntity;
    workspaceMemberId: string;
    userWorkspaceId: string;
    messageId?: string;
  }): Promise<boolean> {
    const workspaceId = workspace.id;
    const [thread, message] = await Promise.all([
      this.threadRepository.findOneOrFail(workspaceId, {
        where: { id: threadId },
      }),
      isDefined(messageId)
        ? this.messageRepository.findOne(workspaceId, {
            where: { id: messageId, threadId, role: AgentMessageRole.USER },
            relations: ['parts'],
          })
        : Promise.resolve(null),
    ]);

    if (isDefined(messageId) && !isDefined(message)) {
      return false;
    }

    const context = readAgentChatAssistantReplyContext(message?.parts);
    const assistantPolicy = await this.assistantPolicyService.resolve({
      workspaceId,
      workspace,
      thread,
    });
    const effectiveAssistantPolicy = {
      ...assistantPolicy,
      isDirectAssistantChat:
        assistantPolicy.isDirectAssistantChat &&
        (context?.isDirectAssistantChat !== false ||
          context?.isStructuredRequestContinuation === true),
    };

    if (effectiveAssistantPolicy.isDirectAssistantChat) {
      return true;
    }

    if (effectiveAssistantPolicy.mode === AiChatAssistantMode.NEVER) {
      return false;
    }

    const isAssistantMentioned = context?.isAssistantMentioned === true;

    if (effectiveAssistantPolicy.mode === AiChatAssistantMode.MENTION_ONLY) {
      return (
        isAssistantMentioned ||
        context?.isStructuredRequestContinuation === true
      );
    }

    const isAssistantParticipating = resolveAgentChatAssistantParticipation({
      ...effectiveAssistantPolicy,
      isAssistantParticipant: thread.isAssistantParticipant ?? true,
      isAssistantMentioned,
    });

    if (!isAssistantParticipating) {
      return false;
    }

    if (context?.isDirectAssistantChat !== true) {
      return true;
    }

    const text = (message?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.textContent ?? '')
      .join('\n');

    return this.replyPolicyService.shouldReply({
      isAiChatInboxEnabled: true,
      shouldAssistantReply: true,
      thread,
      workspace,
      workspaceId,
      workspaceMemberId,
      userWorkspaceId,
      candidateWorkspaceMemberIds: [],
      isAssistantMentioned,
      text,
    });
  }
}
