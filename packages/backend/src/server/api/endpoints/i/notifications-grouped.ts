/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm';
import * as Redis from 'ioredis';
import { Inject, Injectable } from '@nestjs/common';
import type { NotesRepository } from '@/models/_.js';
import {
	obsoleteNotificationTypes,
	groupedNotificationTypes,
	FilterUnionByProperty,
	notificationTypes,
} from '@/types.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { MiGroupedNotification, MiNotification } from '@/models/Notification.js';

export const meta = {
	tags: ['account', 'notifications'],

	requireCredential: true,

	limit: {
		duration: 30000,
		max: 30,
	},

	kind: 'read:notifications',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Notification',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		markAsRead: { type: 'boolean', default: true },
		// 後方互換のため、廃止された通知タイプも受け付ける
		includeTypes: { type: 'array', items: {
			type: 'string', enum: [...notificationTypes, ...obsoleteNotificationTypes],
		} },
		excludeTypes: { type: 'array', items: {
			type: 'string', enum: [...notificationTypes, ...obsoleteNotificationTypes],
		} },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private idService: IdService,
		private notificationEntityService: NotificationEntityService,
		private notificationService: NotificationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const EXTRA_LIMIT = 100;
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate!) : undefined);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate!) : undefined);

			// includeTypes が空の場合はクエリしない
			if (ps.includeTypes && ps.includeTypes.length === 0) {
				return [];
			}
			// excludeTypes に全指定されている場合はクエリしない
			if (notificationTypes.every(type => ps.excludeTypes?.includes(type))) {
				return [];
			}

			const includeTypes = ps.includeTypes && ps.includeTypes.filter(type => !(obsoleteNotificationTypes).includes(type as any)) as typeof groupedNotificationTypes[number][];
			const excludeTypes = ps.excludeTypes && ps.excludeTypes.filter(type => !(obsoleteNotificationTypes).includes(type as any)) as typeof groupedNotificationTypes[number][];

			const notifications = await this.notificationService.getNotifications(me.id, {
				sinceId: sinceId,
				untilId: untilId,
				limit: ps.limit,
				includeTypes,
				excludeTypes,
			});

			if (notifications.length === 0) {
				return [];
			}

			// Mark all as read
			if (ps.markAsRead) {
				this.notificationService.readAllNotification(me.id);
			}

			// grouping
			let groupedNotifications = [notifications[0]] as MiGroupedNotification[];
			for (let i = 1; i < notifications.length; i++) {
				const notification = notifications[i];
				const prev = notifications[i - 1];
				let prevGroupedNotification = groupedNotifications.at(-1)!;

				if (prev.type === 'reaction' && notification.type === 'reaction' && prev.noteId === notification.noteId) {
					if (prevGroupedNotification.type !== 'reaction:grouped') {
						groupedNotifications[groupedNotifications.length - 1] = {
							type: 'reaction:grouped',
							id: '',
							createdAt: prev.createdAt,
							noteId: prev.noteId!,
							reactions: [{
								userId: prev.notifierId!,
								reaction: prev.reaction!,
							}],
						};
						prevGroupedNotification = groupedNotifications.at(-1)!;
					}
					(prevGroupedNotification as FilterUnionByProperty<MiGroupedNotification, 'type', 'reaction:grouped'>).reactions.push({
						userId: notification.notifierId!,
						reaction: notification.reaction!,
					});
					prevGroupedNotification.id = notification.id;
					continue;
				}
				if (prev.type === 'renote' && notification.type === 'renote' && prev.targetNoteId === notification.targetNoteId) {
					if (prevGroupedNotification.type !== 'renote:grouped') {
						groupedNotifications[groupedNotifications.length - 1] = {
							type: 'renote:grouped',
							id: '',
							createdAt: notification.createdAt,
							noteId: prev.noteId!,
							userIds: [prev.notifierId!],
						};
						prevGroupedNotification = groupedNotifications.at(-1)!;
					}
					(prevGroupedNotification as FilterUnionByProperty<MiGroupedNotification, 'type', 'renote:grouped'>).userIds.push(notification.notifierId!);
					prevGroupedNotification.id = notification.id;
					continue;
				}

				groupedNotifications.push(notification);
			}

			groupedNotifications = groupedNotifications.slice(0, ps.limit);

			return await this.notificationEntityService.packGroupedMany(groupedNotifications, me.id);
		});
	}
}
