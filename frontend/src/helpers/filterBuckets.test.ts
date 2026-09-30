import {describe, expect, it} from 'vitest'
import {
	matchesBucketFilter,
	parseBucketFilter,
	planBucketFilterMove,
	type BucketFilterField,
} from '@/helpers/filterBuckets'

const bucket = (filter: string, s = '') => parseBucketFilter({
	filter,
	s,
})

function task(usernames: string[] = [], labelIds: number[] = []) {
	return {
		assignees: usernames.map((username, index) => ({
			id: index + 1,
			username,
		})),
		labels: labelIds.map(id => ({
			id,
			title: `label ${id}`,
		})),
	}
}

describe('parseBucketFilter', () => {
	it.each([
		'assignees in jakob',
		'assignees = jakob',
		'assignees not in jakob, rasmus, katrine',
		'assignees != jakob, rasmus',
		'assignees ?!= jakob, rasmus',
		'labels ?= 4',
		'labels in 5',
		'labels in "5"',
		'labels in 5 && assignees in jakob',
	])('accepts %s', filter => {
		expect(bucket(filter)).not.toBeNull()
	})

	it.each([
		'',
		'assignees in jakob, rasmus',
		'assignees = jakob, rasmus',
		'labels in 5 || labels in 6',
		'(labels in 5) && assignees in jakob',
		'labels in 5 && priority > 3',
		'due_date < now',
		'done = false',
		'assignees like jak',
		'Assignees IN jakob',
		'labels in "foo bar"',
	])('rejects %s', filter => {
		expect(bucket(filter)).toBeNull()
	})

	it('rejects a bucket that also searches', () => {
		expect(bucket('assignees in jakob', 'foo')).toBeNull()
	})

	it('strips quotes from values', () => {
		expect(bucket('assignees in "jakob"')).toEqual([{
			field: 'assignees',
			negated: false,
			values: ['jakob'],
		}])
	})

	it('unquotes a whole list before splitting it', () => {
		expect(bucket('assignees not in "alice, bob"')?.[0].values).toEqual(['alice', 'bob'])
	})
})

describe('matchesBucketFilter', () => {
	it('requires every clause', () => {
		const filter = bucket('labels in 5 && assignees in jakob')!
		expect(matchesBucketFilter(task(['jakob'], [5]), filter)).toBe(true)
		expect(matchesBucketFilter(task(['jakob']), filter)).toBe(false)
	})

	it('matches labels by numeric id and users by exact username', () => {
		expect(matchesBucketFilter(task([], [5]), bucket('labels in 05')!)).toBe(true)
		expect(matchesBucketFilter(task(['Jakob']), bucket('assignees in jakob')!)).toBe(false)
	})

	it('matches the catch-all when none of the excluded values are present', () => {
		const filter = bucket('assignees not in jakob, rasmus')!
		expect(matchesBucketFilter(task(), filter)).toBe(true)
		expect(matchesBucketFilter(task(['troels']), filter)).toBe(true)
		expect(matchesBucketFilter(task(['rasmus']), filter)).toBe(false)
	})

	it('matches tasks without a value when nulls are included', () => {
		const filter = bucket('assignees in jakob')!
		expect(matchesBucketFilter(task(), filter, true)).toBe(true)
		expect(matchesBucketFilter(task(['rasmus']), filter, true)).toBe(false)
	})
})

describe('planBucketFilterMove', () => {
	const edit = (field: BucketFilterField, value: string, add: boolean) => ({
		field,
		value,
		add,
	})
	const add = (field: BucketFilterField, value: string) => edit(field, value, true)
	const remove = (field: BucketFilterField, value: string) => edit(field, value, false)

	it('reassigns between single-assignee buckets', () => {
		const edits = planBucketFilterMove(
			task(['jakob']),
			bucket('assignees in jakob'),
			bucket('assignees in rasmus')!,
		)
		expect(edits).toEqual([
			add('assignees', 'rasmus'),
			remove('assignees', 'jakob'),
		])
	})

	it('assigns from the catch-all without removing anything', () => {
		const edits = planBucketFilterMove(
			task(),
			bucket('assignees not in jakob, rasmus'),
			bucket('assignees in jakob')!,
		)
		expect(edits).toEqual([
			add('assignees', 'jakob'),
		])
	})

	it('unassigns every excluded user when dropped on the catch-all', () => {
		const edits = planBucketFilterMove(
			task(['jakob', 'rasmus', 'troels']),
			bucket('assignees in jakob'),
			bucket('assignees not in jakob, rasmus')!,
		)
		expect(edits).toEqual([
			remove('assignees', 'jakob'),
			remove('assignees', 'rasmus'),
		])
	})

	it('applies every value of a multi-clause target in one drop', () => {
		const edits = planBucketFilterMove(
			task(),
			bucket('assignees not in jakob'),
			bucket('labels in 5 && assignees in jakob')!,
		)
		expect(edits).toEqual([
			add('labels', '5'),
			add('assignees', 'jakob'),
		])
	})

	it('keeps source values the target also requires', () => {
		const edits = planBucketFilterMove(
			task(['jakob'], [5]),
			bucket('labels in 5 && assignees in jakob'),
			bucket('labels in 6 && assignees in jakob')!,
		)
		expect(edits).toEqual([
			add('labels', '6'),
			remove('labels', '5'),
		])
	})

	it('only applies the target when the source bucket is not editable', () => {
		expect(planBucketFilterMove(task(['rasmus']), null, bucket('assignees in jakob')!)).toEqual([
			add('assignees', 'jakob'),
		])
	})

	it('removes a value only once when the source requires it and the target excludes it', () => {
		const edits = planBucketFilterMove(
			task(['jakob']),
			bucket('assignees in jakob'),
			bucket('assignees not in jakob, rasmus')!,
		)
		expect(edits).toEqual([
			remove('assignees', 'jakob'),
		])
	})

	it('skips values the task already has', () => {
		const edits = planBucketFilterMove(task(['jakob'], [6]), bucket('assignees in jakob'), bucket('labels in 6')!)
		expect(edits).toEqual([
			remove('assignees', 'jakob'),
		])
	})
})
