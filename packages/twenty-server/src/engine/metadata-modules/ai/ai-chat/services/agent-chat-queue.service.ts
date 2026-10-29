import { Inject, Injectable } from '@nestjs/common';

import { FileFolder } from 'twenty-shared/types';
import { isNonEmptyArray } from 'twenty-shared/utils';
import { In, Like } from 'typeorm';

import { FileEntity } from 'src/engine/core-modules/file/entities/file.entity';
import { AgentChatThreadService } from 'src/engine/metadata-modules/ai/ai-chat/services/agent-chat-thread.service';
import { type AiChatFileAttachment } from 'src/engine/metadata-modules/ai/ai-chat/types/ai-chat-file-attachment.type';
import { resolveMessageSenderApplicationId } from 'src/engine/metadata-modules/ai/ai-chat/utils/resolve-message-sender-application-id.util';
import { AgentMessageRole } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-message-role.enum';
import { AgentMessageStatus } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-message-status.enum';
import { AgentTurnStatus } from 'src/engine/metadata-modules/ai/ai-history/enums/agent-turn-status.enum';
import { type AgentHistoryRepository } from 'src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository';
import { getAgentHistoryRepositoryToken } from 'src/engine/metadata-modules/ai/ai-history/repositories/inject-agent-history-repository.decorator';
import { AgentConversationWriterService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-conversation-writer.service';
import { type AgentMessageWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-message.workspace-entity';
import { type AgentTurnWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-turn.workspace-entity';
import { getWorkspaceScopedRepositoryToken } from 'src/engine/twenty-orm/workspace-scoped-repository/get-workspace-scoped-repository-token.util';
import { type WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { type AgentChatAssistantReplyContext } from 'src/engine/metadata-modules/ai/ai-chat/types/agent-chat-assistant-reply-context.type';
import { buildAgentChatAssistantReplyProviderMetadata } from 'src/engine/metadata-modules/ai/ai-chat/utils/build-agent-chat-assistant-reply-provider-metadata.util';

@Injectable()
export class AgentChatQueueService {
  @Inject(getAgentHistoryRepositoryToken('agentTurn'))
  private readonly turnRepository: AgentHistoryRepository<AgentTurnWorkspaceEntity>;

  @Inject(getAgentHistoryRepositoryToken('agentMessage'))
  private readonly messageRepository: AgentHistoryRepository<AgentMessageWorkspaceEntity>;

  @Inject(getWorkspaceScopedRepositoryToken(FileEntity))
  private readonly fileRepository: WorkspaceScopedRepository<FileEntity>;

  @Inject(AgentConversationWriterService)
  private readonly conversationWriterService: AgentConversationWriterService;

  @Inject(AgentChatThreadService)
  private readonly threadService: AgentChatThreadService;

  async queueMessage({
    threadId,
    text,
    id,
    fileAttachments,
    workspaceId,
    userWorkspaceId,
    workspaceMemberId,
    assistantReplyContext,
  }: {
    threadId: string;
    text: string;
    id?: string;
    fileAttachments?: AiChatFileAttachment[];
    workspaceId: string;
    userWorkspaceId: string;
    workspaceMemberId: string;
    assistantReplyContext?: AgentChatAssistantReplyContext;
  }) {
    const messageValues = {
      ...(id ? { id } : {}),
      threadId,
      turnId: null,
      role: AgentMessageRole.USER,
      agentId: null,
      status: AgentMessageStatus.QUEUED,
      senderWorkspaceMemberId: workspaceMemberId,
      senderApplicationId: resolveMessageSenderApplicationId({
        workspaceId,
        userWorkspaceId,
      }),
    };

    const insertResult = await this.messageRepository.insert(
      workspaceId,
      messageValues,
    );

    const savedMessageId = (id ?? insertResult.identifiers[0].id) as string;

    const validFiles = isNonEmptyArray(fileAttachments)
      ? await this.fileRepository.find(workspaceId, {
          where: {
            id: In(fileAttachments.map((attachment) => attachment.id)),
            path: Like(`${FileFolder.AgentChat}/%`),
          },
          select: ['id'],
        })
      : [];

    const validFileIds = new Set(validFiles.map((file) => file.id));

    const parts = [
      {
        messageId: savedMessageId,
        orderIndex: 0,
        type: 'text',
        textContent: text,
        providerMetadata: buildAgentChatAssistantReplyProviderMetadata(
          assistantReplyContext,
        ),
      },
      ...(fileAttachments ?? [])
        .filter((attachment) => validFileIds.has(attachment.id))
        .map((attachment, index) => ({
          messageId: savedMessageId,
          orderIndex: index + 1,
          type: 'file',
          fileId: attachment.id,
          fileFilename: attachment.filename,
        })),
    ];

    await this.conversationWriterService.runInTransaction(
      workspaceId,
      (scope) => scope.insert('agentMessagePart', parts),
    );

    await this.threadService.notifyThreadActivityUpdated({
      threadId,
      workspaceMemberId,
      workspaceId,
      text,
    });

    return {
      id: savedMessageId,
      ...messageValues,
    };
  }

  async hasQueuedMessages({
    threadId,
    workspaceId,
  }: {
    threadId: string;
    workspaceId: string;
  }): Promise<boolean> {
    return this.messageRepository.existsBy(workspaceId, {
      threadId,
      status: AgentMessageStatus.QUEUED,
    });
  }

  async getQueuedMessages({
    threadId,
    workspaceId,
  }: {
    threadId: string;
    workspaceId: string;
  }): Promise<AgentMessageWorkspaceEntity[]> {
    return this.messageRepository.find(workspaceId, {
      where: {
        threadId,
        status: AgentMessageStatus.QUEUED,
      },
      order: { createdAt: 'ASC' },
      relations: ['parts', 'parts.file'],
    });
  }

  async findQueuedMessage({
    messageId,
    workspaceId,
  }: {
    messageId: string;
    workspaceId: string;
  }): Promise<AgentMessageWorkspaceEntity | null> {
    return this.messageRepository.findOne(workspaceId, {
      where: { id: messageId, status: AgentMessageStatus.QUEUED },
    });
  }

  async deleteQueuedMessage({
    messageId,
    workspaceId,
  }: {
    messageId: string;
    workspaceId: string;
  }): Promise<boolean> {
    const result = await this.messageRepository.delete(workspaceId, {
      id: messageId,
      status: AgentMessageStatus.QUEUED,
    });

    return (result.affected ?? 0) > 0;
  }

  async promoteQueuedMessage({
    messageId,
    threadId,
    workspaceId,
  }: {
    messageId: string;
    threadId: string;
    workspaceId: string;
  }): Promise<string | null> {
    const savedTurnId = await this.conversationWriterService.insertTurn({
      workspaceId,
      threadId,
      agentId: null,
      status: AgentTurnStatus.RUNNING,
    });

    const result = await this.messageRepository.update(
      workspaceId,
      { id: messageId, threadId, status: AgentMessageStatus.QUEUED },
      {
        status: AgentMessageStatus.SENT,
        processedAt: new Date().toISOString(),
        turnId: savedTurnId,
      },
    );

    if ((result.affected ?? 0) === 0) {
      await this.turnRepository.delete(workspaceId, { id: savedTurnId });

      return null;
    }

    return savedTurnId;
  }
}
