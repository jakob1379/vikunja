import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useQueryClient} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import type {Label, ProjectView, User} from '@/client/generated'
import {kanbanKeys, type BoardData} from '@/client/queries/kanban'
import {ensureLabels, getLabelById, refreshLabels} from '@/client/queries/labels'
import {
	useAddTaskAssigneeMutation,
	useAddTaskLabelMutation,
	useRemoveTaskAssigneeMutation,
	useRemoveTaskLabelMutation,
} from '@/client/queries/taskMutations'
import type {TaskFilterParams, TaskResponse} from '@/client/queries/tasks'
import {searchProjectUsers, searchUsers} from '@/client/queries/userSearch'
import {
	findFilterValue,
	matchesBucketFilter,
	parseBucketFilter,
	planBucketFilterMove,
	type BucketFilterEdit,
} from '@/helpers/filterBuckets'
import {error} from '@/message'

type WithId<T> = T & {id: number}

type Move = {
	task: TaskResponse
	from: number
	to: number
	index: number
}

const MEMBERSHIP_FIELDS = /\b(assignees|labels)\b/

export function useFilterBucketMove(
	project: MaybeRefOrGetter<number>,
	view: MaybeRefOrGetter<ProjectView | null>,
	params: MaybeRefOrGetter<TaskFilterParams>,
) {
	const {t} = useI18n({useScope: 'global'})
	const client = useQueryClient()
	const addAssignee = useAddTaskAssigneeMutation()
	const removeAssignee = useRemoveTaskAssigneeMutation()
	const addLabel = useAddTaskLabelMutation()
	const removeLabel = useRemoveTaskLabelMutation()

	const filters = computed(() => {
		const current = toValue(view)
		return current?.bucket_configuration_mode === 'filter'
			? (current.bucket_configuration ?? []).map(bucket => parseBucketFilter(bucket.filter))
			: []
	})
	const filterOf = (bucketId: number) => filters.value[bucketId] ?? null
	const canDrop = (bucketId: number) => filterOf(bucketId) !== null

	async function findUser(username: string) {
		const id = toValue(project)
		const users = id > 0
			? await searchProjectUsers(id, username)
			: await searchUsers(username)
		return users.find(user => user.username === username)
	}

	async function findLabel(value: string) {
		const id = Number(value)
		return getLabelById(await ensureLabels(), id) ?? getLabelById(await refreshLabels(), id)
	}

	async function resolve(task: TaskResponse, {field, value, add}: BucketFilterEdit) {
		const found = add
			? await (field === 'assignees' ? findUser(value) : findLabel(value))
			: findFilterValue(task, field, value)
		if (found?.id === undefined) throw new Error(t('project.kanban.filterBucketValueNotFound', {value}))
		const taskId = task.id
		if (field === 'assignees') {
			const user = found as WithId<User>
			return () => (add ? addAssignee : removeAssignee).mutateAsync({
				taskId,
				user,
			})
		}
		const label = found as WithId<Label>
		return () => (add ? addLabel : removeLabel).mutateAsync({
			taskId,
			label,
		})
	}

	const boardKey = () => kanbanKeys.board(toValue(project), toValue(view)?.id ?? 0, toValue(params))

	const needsRefetch = () => toValue(project) < 0 ||
		MEMBERSHIP_FIELDS.test(`${toValue(view)?.filter?.filter ?? ''} ${toValue(params).filter ?? ''}`)

	function refetchBoard() {
		return client.invalidateQueries({
			queryKey: boardKey(),
			refetchType: 'active',
		})
	}

	// ponytail: only loaded pages of parseable buckets are re-evaluated; boards that need a refetch lose their
	// extra loaded pages. Patch those per page if long filtered boards become common.
	function patchBoard(taskId: number, target: number, index: number) {
		const current = toValue(view)
		const boardParams = toValue(params)
		const includeNulls = Boolean(current?.filter?.filter_include_nulls || boardParams.filter_include_nulls)
		client.setQueryData<BoardData>(boardKey(), board => {
			const task = board?.buckets.flatMap(bucket => bucket.tasks).find(item => item.id === taskId)
			if (!board || !task) return board
			return {
				...board,
				buckets: board.buckets.map(bucket => {
					const clauses = filterOf(bucket.id)
					if (!clauses) return bucket
					const present = bucket.tasks.some(item => item.id === taskId)
					const wanted = matchesBucketFilter(task, clauses, includeNulls)
					if (present === wanted) return bucket
					if (!wanted) {
						return {
							...bucket,
							count: Math.max(0, bucket.count - 1),
							tasks: bucket.tasks.filter(item => item.id !== taskId),
						}
					}
					const tasks = [...bucket.tasks]
					tasks.splice(bucket.id === target ? index : 0, 0, task)
					return {
						...bucket,
						count: bucket.count + 1,
						tasks,
					}
				}),
			}
		})
	}

	async function move({task, from, to, index}: Move): Promise<boolean> {
		const target = filterOf(to)
		if (!target) return false
		const planned = planBucketFilterMove(task, filterOf(from), target)
		const writes = await Promise.all(planned.map(edit => resolve(task, edit)))
			.catch(cause => {
				error(cause)
				throw cause
			})
		let applied = false
		try {
			for (const write of writes) {
				await write()
				applied = true
			}
		} catch (cause) {
			if (applied && needsRefetch()) void refetchBoard()
			else if (applied) patchBoard(task.id, to, index)
			throw cause
		}
		if (!applied) return false
		if (needsRefetch()) return true
		patchBoard(task.id, to, index)
		return false
	}

	return {
		canDrop,
		move,
		refetchBoard,
	}
}
