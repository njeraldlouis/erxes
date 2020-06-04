import client from 'apolloClient';
import gql from 'graphql-tag';
import * as compose from 'lodash.flowright';
import { Alert, withProps } from 'modules/common/utils';
import { UserDetailQueryResponse } from 'modules/settings/team/types';
import React from 'react';
import { graphql } from 'react-apollo';
import { requestIdleCallback } from 'request-idle-callback';
import { mutations, queries, subscriptions } from '../graphql';
import {
  IDragResult,
  IFilterParams,
  IItem,
  IItemMap,
  INonFilterParams,
  IOptions,
  IPipeline,
  PipelineDetailQueryResponse
} from '../types';
import { invalidateCache, orderHelper } from '../utils';
import { reorder, reorderItemMap } from '../utils';

type WrapperProps = {
  pipeline: IPipeline;
  initialItemMap?: IItemMap;
  options: IOptions;
  queryParams: IFilterParams & INonFilterParams;
  queryParamsChanged: (
    queryParams: IFilterParams,
    nextQueryParams: IFilterParams
  ) => boolean;
};

type Props = WrapperProps & {
  currentUserQuery: UserDetailQueryResponse;
  pipelineDetailQuery: any;
};

type StageLoadMap = {
  [key: string]: 'readyToLoad' | 'loaded';
};

type State = {
  itemMap: IItemMap;
  stageLoadMap: StageLoadMap;
  stageIds: string[];
  isShowLabel: boolean;
};

interface IStore {
  options: IOptions;
  itemMap: IItemMap;
  stageLoadMap: StageLoadMap;
  stageIds: string[];
  onLoadStage: (stageId: string, items: IItem[]) => void;
  scheduleStage: (stageId: string) => void;
  onDragEnd: (result: IDragResult) => void;
  onAddItem: (stageId: string, item: IItem) => void;
  onRemoveItem: (itemId: string, stageId: string) => void;
  onUpdateItem: (item: IItem, prevStageId?: string) => void;
  isShowLabel: boolean;
  toggleLabels: () => void;
}

const PipelineContext = React.createContext({} as IStore);

export const PipelineConsumer = PipelineContext.Consumer;

type Task = {
  handler: (stageId: string) => void;
  stageId: string;
  isComplete: boolean;
};

class PipelineProviderInner extends React.Component<Props, State> {
  static tasks: Task[] = [];
  static currentTask: Task | null;

  constructor(props: Props) {
    super(props);

    const { pipeline, pipelineDetailQuery, initialItemMap } = props;

    const stageIds = Object.keys(initialItemMap || {});

    this.state = {
      itemMap: initialItemMap || {},
      stageLoadMap: {},
      stageIds,
      isShowLabel: false
    };

    PipelineProviderInner.tasks = [];
    PipelineProviderInner.currentTask = null;

    pipelineDetailQuery.subscribeToMore({
      document: gql(subscriptions.pipelinesChanged),
      variables: { _id: pipeline._id },
      updateQuery: (
        prev,
        {
          subscriptionData: {
            data: { pipelinesChanged }
          }
        }
      ) => {
        const {
          data: {
            destinationStageId,
            destinationIndex,
            oldStageId,
            oldIndex,
            updateOrderProccessId
          },
          itemId
        } = pipelinesChanged;

        if (
          updateOrderProccessId !==
          localStorage.getItem('updateOrderProccessId')
        ) {
          this.onDragEnd(
            {
              destination: {
                droppableId: destinationStageId,
                index: destinationIndex
              },
              draggableId: itemId,
              combine: null,
              mode: 'FLUID',
              reason: 'DROP',
              source: {
                droppableId: oldStageId,
                index: oldIndex
              },
              type: 'DEFAULT'
            },
            false
          );
        }
      }
    });
  }

  componentWillReceiveProps(nextProps: Props) {
    const { queryParams, queryParamsChanged } = this.props;

    if (queryParamsChanged(queryParams, nextProps.queryParams)) {
      const { stageIds } = this.state;

      PipelineProviderInner.tasks = [];
      PipelineProviderInner.currentTask = null;

      stageIds.forEach((stageId: string) => {
        this.scheduleStage(stageId);
      });
    }
  }

  onDragEnd = (result, saveToDb = true) => {
    // dropped nowhere
    if (!result.destination) {
      return;
    }

    const source = result.source;
    const destination = result.destination;

    // did not move anywhere - can bail early
    if (
      source.droppableId === destination.droppableId &&
      source.index === destination.index
    ) {
      return;
    }

    // reordering stage
    if (result.type === 'STAGE') {
      const stageIds = reorder(
        this.state.stageIds,
        source.index,
        destination.index
      );

      this.setState({ stageIds });

      // save orders to database
      if (saveToDb) {
        return this.saveStageOrders(stageIds);
      }
    }

    const { itemMap, target } = reorderItemMap({
      itemMap: this.state.itemMap,
      source,
      destination
    });

    this.setState({
      itemMap
    });

    invalidateCache();

    // saving to database
    if (saveToDb) {
      this.itemChange({
        itemId: target._id,
        destinationStageId: destination.droppableId,
        destinationIndex: destination.index,
        destinationOrder: target.order,
        sourceStageId: source.droppableId,
        sourceIndex: source.index
      });
    }
  };

  refetchQueryVariables = () => {
    const { options, queryParams } = this.props;

    return {
      search: queryParams.search,
      customerIds: queryParams.customerIds,
      companyIds: queryParams.companyIds,
      assignedUserIds: queryParams.assignedUserIds,
      extraParams: options.getExtraParams(queryParams),
      closeDateType: queryParams.closeDateType,
      userIds: queryParams.userIds
    };
  };

  refetchQueryBuild = (stageId: string) => {
    return {
      query: gql(queries.stageDetail),
      variables: {
        _id: stageId,
        ...this.refetchQueryVariables()
      }
    };
  };

  refetchStagesQueryBuild = (pipelineId: string) => {
    return {
      query: gql(queries.stages),
      variables: {
        pipelineId,
        ...this.refetchQueryVariables()
      }
    };
  };

  itemChange = (args: {
    itemId: string;
    destinationStageId: string;
    destinationIndex: number;
    destinationOrder: number;
    sourceStageId: string;
    sourceIndex: number;
  }) => {
    const {
      itemId,
      destinationStageId,
      destinationIndex,
      destinationOrder,
      sourceStageId,
      sourceIndex
    } = args;

    const { options } = this.props;
    const refetchQueries = [this.refetchQueryBuild(destinationStageId)];

    if (sourceStageId) {
      refetchQueries.unshift(this.refetchQueryBuild(sourceStageId));
    }

    const updateOrderProccessId = Math.random().toString();

    localStorage.setItem('updateOrderProccessId', updateOrderProccessId);

    client
      .mutate({
        mutation: gql(options.mutations.changeMutation),
        variables: {
          itemId,
          destinationStageId,
          destinationIndex,
          destinationOrder,
          sourceStageId,
          sourceIndex,
          updateOrderProccessId
        },
        refetchQueries
      })
      .catch((e: Error) => {
        Alert.error(e.message);
      });
  };

  saveStageOrders = (stageIds: string[]) => {
    const { pipeline } = this.props;

    client
      .mutate({
        mutation: gql(mutations.stagesUpdateOrder),
        variables: {
          orders: stageIds.map((stageId, index) => ({
            _id: stageId,
            order: index
          }))
        },
        refetchQueries: [this.refetchStagesQueryBuild(pipeline._id)]
      })
      .catch((e: Error) => {
        Alert.error(e.message);
      });
  };

  /*
   * - Stage container is sending loaded to items
   * - Storing sent items to global itemsMap
   * - Mark stage's task as complete
   * - Mark stage's loading state as loaded
   */
  onLoadStage = (stageId: string, items: IItem[]) => {
    const { itemMap, stageLoadMap } = this.state;
    const task = PipelineProviderInner.tasks.find(t => t.stageId === stageId);

    if (task) {
      task.isComplete = true;
    }

    this.setState({
      itemMap: { ...itemMap, [stageId]: items },
      stageLoadMap: { ...stageLoadMap, [stageId]: 'loaded' }
    });
  };

  /*
   * Register given stage to tasks queue
   */
  scheduleStage = (stageId: string) => {
    let currentTask = PipelineProviderInner.currentTask;

    PipelineProviderInner.tasks.push({
      handler: (id: string) => {
        const { stageLoadMap } = this.state;
        const states = Object.values(stageLoadMap);

        if (!states.includes('readyToLoad')) {
          this.setState({
            stageLoadMap: { ...stageLoadMap, [id]: 'readyToLoad' }
          });
        }
      },
      stageId,
      isComplete: false
    });

    if (!currentTask) {
      currentTask = requestIdleCallback(this.runTaskQueue);
    }
  };

  /*
   * If browser is idle then find first inComplete task and run it
   */
  runTaskQueue = (deadline: {
    didTimeout: boolean;
    timeRemaining: () => number;
  }) => {
    const inCompleteTask = PipelineProviderInner.tasks.find(
      (task: Task) => !task.isComplete
    );

    while (
      (deadline.timeRemaining() > 0 || deadline.didTimeout) &&
      inCompleteTask
    ) {
      const { handler, stageId } = inCompleteTask;
      handler(stageId);
    }

    PipelineProviderInner.currentTask = null;

    if (inCompleteTask) {
      PipelineProviderInner.currentTask = requestIdleCallback(
        this.runTaskQueue
      );
    }
  };

  onAddItem = (stageId: string, item: IItem) => {
    const { itemMap } = this.state;
    const items = itemMap[stageId];

    this.setState({
      itemMap: { ...itemMap, [stageId]: [...items, item] }
    });
  };

  onRemoveItem = (itemId: string, stageId: string) => {
    const { itemMap } = this.state;

    const items = itemMap[stageId].filter(item => item._id !== itemId);

    this.setState({
      itemMap: { ...itemMap, [stageId]: items }
    });
  };

  onUpdateItem = (item: IItem, prevStageId?: string) => {
    const { stageId } = item;
    const { itemMap } = this.state;

    // Moved to anothor board or pipeline
    if (!itemMap[stageId] && prevStageId) {
      return this.onRemoveItem(item._id, prevStageId);
    }

    if (item.status === 'archived') {
      return this.onRemoveItem(item._id, item.stageId);
    }

    // Moved between stages
    if (prevStageId && stageId !== prevStageId) {
      // remove from old stage
      const prevStageItems = itemMap[prevStageId].filter(
        (d: IItem) => d._id !== item._id
      );

      // add to new stage's front
      const items = [...itemMap[stageId]];
      items.unshift(item);

      const newitemMap = {
        ...itemMap,
        [stageId]: items,
        [prevStageId]: prevStageItems
      };

      this.setState({ itemMap: newitemMap }, () => {
        const afterItem = itemMap[stageId][0];

        item.order = orderHelper({
          prevOrder: 0,
          afterOrder: afterItem ? afterItem.order : 0
        });

        // this.itemChange(item._id, stageId, item.order, prevStageId);
      });
    } else {
      const items = [...itemMap[stageId]];
      const index = items.findIndex(d => d._id === item._id);

      items[index] = item;

      this.setState({
        itemMap: { ...itemMap, [stageId]: items }
      });
    }
  };

  toggleLabels = () => {
    this.setState({ isShowLabel: !this.state.isShowLabel });
  };

  render() {
    const { itemMap, stageLoadMap, stageIds, isShowLabel } = this.state;

    return (
      <PipelineContext.Provider
        value={{
          options: this.props.options,
          onDragEnd: this.onDragEnd,
          onLoadStage: this.onLoadStage,
          scheduleStage: this.scheduleStage,
          onAddItem: this.onAddItem,
          onRemoveItem: this.onRemoveItem,
          onUpdateItem: this.onUpdateItem,
          itemMap,
          stageLoadMap,
          stageIds,
          isShowLabel,
          toggleLabels: this.toggleLabels
        }}
      >
        {this.props.children}
      </PipelineContext.Provider>
    );
  }
}

export const PipelineProvider = withProps<WrapperProps>(
  compose(
    graphql<Props, PipelineDetailQueryResponse>(gql(queries.pipelineDetail), {
      name: 'pipelineDetailQuery',
      options: ({ pipeline }) => ({
        variables: { _id: pipeline._id }
      })
    })
  )(PipelineProviderInner)
);
