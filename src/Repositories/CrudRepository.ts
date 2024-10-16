import NotFoundError from '../Errors/NotFoundError';
import TooManyResultsError from '../Errors/TooManyResultsError';
import DatabaseInterface from '../Databases/DatabaseInterface';
import SqlQuery from '../Queries/SqlQuery';
import QueryIdentifier from '../Queries/QueryIdentifier';

const sql = SqlQuery.createFromTemplateString;

export type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
export type RequiredModel<T> = {[K in RequiredKeys<T>] : T[K]}
export default class CrudRepository<Model, ValidAttributes = Model, PrimaryKeyType = any> {
	readonly database: DatabaseInterface;
	readonly table: string;
	readonly primaryKey: string;
	protected readonly model: new (attributes: ValidAttributes) => Model;
	protected readonly scope: SqlQuery|null;

	constructor({
		database,
		table,
		model,
		primaryKey,
		scope = null,
	}: {
		database: DatabaseInterface,
		table: string,
		primaryKey: string,
		model: new (attributes: ValidAttributes) => Model,
		scope?: SqlQuery|null,
	}) {
		this.database = database;
		this.table = table;
		this.primaryKey = primaryKey;
		this.model = model;
		this.scope = scope;
	}

	public async get(primaryKeyValue: PrimaryKeyType, {postfix, select }:{postfix?: SqlQuery, select?: SqlQuery} ={}): Promise<Model> {
		const filters: SqlQuery[] = [
			sql`${new QueryIdentifier(this.primaryKey)} = ${primaryKeyValue}`,
		];
		if (this.scope !== null) {
			filters.push(sql`(${this.scope})`);
		}

		const postfixClause = postfix
			? sql`${postfix}`:sql``;
			const selectClause = select
				? sql`${select}`:sql`*`;
		const results = await this.database.query(sql`
			SELECT ${selectClause}
			FROM ${new QueryIdentifier(this.table)}
			WHERE ${SqlQuery.join(filters, sql` AND `)}
			${postfixClause};
		`);

		if (results.length === 0) {
			throw new NotFoundError(`Object not found in table ${this.table} for ${this.primaryKey} = ${primaryKeyValue}`);
		}
		if (results.length > 1) {
			throw new TooManyResultsError(`Multiple objects found in table ${this.table} for ${this.primaryKey} = ${primaryKeyValue}`);
		}

		return this.createModelFromAttributes(results[0]);
	}

	public async search({from, postfix, where, groupBy, orderBy, select }:{from?: SqlQuery, postfix?: SqlQuery, where?: SqlQuery, groupBy?: SqlQuery, orderBy?: SqlQuery, select?: SqlQuery} ={} ): Promise<Array<Model>> {
		const filters: SqlQuery[] = [];
		if (this.scope ) {
			filters.push(sql`(${this.scope})`);
		}
		if (where ) {
			filters.push(sql`(${where})`);
		}

		const whereClause = filters.length !== 0
			? sql`WHERE ${SqlQuery.join(filters, sql` AND `)}` : sql``;
		const orderByClause = orderBy
			? sql`ORDER BY ${orderBy}`: sql``;
		const groupByClause = groupBy
			? sql`GROUP BY ${groupBy}`: sql``;
		const postfixClause = postfix
			? sql`${postfix}`:sql``;
		const selectClause = select
			? sql`${select}`:sql`*`;
		const fromClause = select
			? sql`${from}`:sql`${new QueryIdentifier(this.table)}`;

		const results = await this.database.query(sql`
			SELECT ${selectClause}
			FROM ${fromClause} ${postfixClause}
			${whereClause}
			${groupByClause}
			${orderByClause}
		`);

		return Promise.all(
			results.map(
				result => this.createModelFromAttributes(result),
			),
		);
	}

	public async create(attributes: ValidAttributes): Promise<Model> {
		return this.database.sequence(async (sequenceDb: DatabaseInterface): Promise<Model> => {
			const entries = Object.entries(attributes as any);
			const fields = entries.map(([key, _]: [string, any]) => sql`${new QueryIdentifier(key)}`);
			const values = entries.map(([_, val]: [string, any]) => sql`${val}`);

			const data = (await sequenceDb.insertAndGet(sql`
				INSERT INTO ${new QueryIdentifier(this.table)} (${SqlQuery.join(fields, sql`, `)})
				VALUES (${SqlQuery.join(values, sql`, `)})
			`))[0];

			if (typeof data === 'string' || typeof data === 'number') {
				const results = await sequenceDb.query(sql`
					SELECT *
					FROM ${new QueryIdentifier(this.table)}
					WHERE ${new QueryIdentifier(this.primaryKey)} = ${data};
				`);

				if (results.length === 0) {
					throw new NotFoundError(`Object not found in table ${this.table} after insert (got ${this.primaryKey} = ${data})`);
				}

				return this.createModelFromAttributes(results[0]);
			} else {
				return this.createModelFromAttributes(data || attributes);
			}
		});
	}

	public async update(model: Model, attributes: Partial<ValidAttributes>): Promise<Model> {
		return this.database.sequence(async (sequenceDb: DatabaseInterface): Promise<Model> => {
			const fieldQueries = Object.entries(attributes).map(
				([key, value]: [string, any]) => (
					sql`${new QueryIdentifier(key)} = ${value}`
				)
			);

			let results = await sequenceDb.updateAndGet(sql`
				UPDATE ${new QueryIdentifier(this.table)}
				SET ${SqlQuery.join(fieldQueries, sql`, `)}
				WHERE ${new QueryIdentifier(this.primaryKey)} = ${(<any>model)[this.primaryKey]}
			`);

			if (results === null) {
				results = await sequenceDb.query(sql`
					SELECT *
					FROM ${new QueryIdentifier(this.table)}
					WHERE ${new QueryIdentifier(this.primaryKey)} = ${(<any>model)[this.primaryKey]};
				`);

				if (results.length === 0) {
					throw new NotFoundError(`Object not found in table ${this.table} after update (got ${this.primaryKey} = ${(<any>model)[this.primaryKey]})`);
				}
			} else {
				if (results.length === 0) {
					throw new NotFoundError(`Object not found in table ${this.table} for ${this.primaryKey} = ${(<any>model)[this.primaryKey]}`);
				}
				if (results.length > 1) {
					throw new TooManyResultsError(`Multiple objects found in table ${this.table} for ${this.primaryKey} = ${(<any>model)[this.primaryKey]}`);
				}
			}

			Object.assign(<object>model, results[0]);
			return model;
		});
	}

	public async delete(model: Model) {
		await this.database.query(sql`
			DELETE FROM ${new QueryIdentifier(this.table)}
			WHERE ${new QueryIdentifier(this.primaryKey)} = ${(<any>model)[this.primaryKey]};
		`);
	}

	protected async createModelFromAttributes(attributes: ValidAttributes|Model): Promise<Model> {
		const model = Object.create(this.model.prototype);
		Object.assign(model, attributes);
		return model;
	}
}
